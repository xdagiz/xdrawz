import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { UnsavedChoice, UnsavedReason } from "@shared/ipc";
import { DEFAULT_AUTOSAVE_INTERVAL_MS } from "@shared/ipc";

import { debounceAsync } from "@/lib/debounce";

export const MAX_SAVE_RETRIES = 3;

export type SaveOrigin = "auto" | "explicit";

type DrawingSnapshot = [readonly OrderedExcalidrawElement[], AppState, BinaryFiles];

type FlushOpts = {
  force?: boolean;
};

export type FrameScheduler = (callback: () => void) => () => void;

const requestFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }

  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
};

export type DrawingSessionControls = {
  onChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  saveNow: () => Promise<boolean>;
  flush: (opts?: FlushOpts) => Promise<void>;
  setAutosavePaused: (paused: boolean) => void;
  getSerializedContent: () => string | null;
  setInitialBaseline: (signature: string | null) => void;
  resetBaseline: () => void;
  retarget: (nextFileId: string) => void;
  ensureCleanOrConfirm: (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => Promise<boolean>;
  isDirty: () => boolean;
  evaluateNow: () => void;
  setAutosaveInterval: (nextMs: number) => void;
  dispose: () => void;
};

type DrawingSessionDeps = {
  fileId: string;
  save: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onSaveGaveUp?: (fileId: string) => void;
  initialBaseline?: string | null;
  scheduleFrame?: FrameScheduler;
};

export const drawingSignature = (
  elements: readonly OrderedExcalidrawElement[],
  appState: RestoredDataState["appState"],
  files: BinaryFiles | undefined,
) =>
  JSON.stringify({
    elements: elements ?? [],
    files: files ?? {},
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    gridModeEnabled: appState.gridModeEnabled,
  });

export const createDrawingSession = (deps: DrawingSessionDeps): DrawingSessionControls => {
  const {
    fileId,
    save,
    onDirtyChange,
    onSaveGaveUp,
    initialBaseline = null,
    scheduleFrame = requestFrame,
  } = deps;

  let baseline: string | null = null;
  let diskBaseline = initialBaseline;
  let currentFileId = fileId;
  let retargetEpoch = 0;
  let latestDrawing: DrawingSnapshot | null = null;
  let latestSignature: string | null = null;
  let latestRevision = 0;
  let savesInFlight = 0;
  let disposed = false;
  let blocked = false;
  let dirty = false;
  let saveFailures = 0;
  let lastSaveOk = false;
  let cancelScheduledEvaluation: (() => void) | null = null;

  const setDirty = (next: boolean) => {
    if (dirty === next) return;
    dirty = next;
    onDirtyChange?.(currentFileId, next);
  };

  let cachedInputs: {
    elements: readonly OrderedExcalidrawElement[];
    files: BinaryFiles | undefined;
    viewBackgroundColor: unknown;
    gridSize: unknown;
    gridStep: unknown;
    gridModeEnabled: unknown;
  } | null = null;
  let cachedSignature = "";

  const signatureFor = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles | undefined,
  ) => {
    if (
      cachedInputs !== null &&
      cachedInputs.elements === elements &&
      cachedInputs.files === files &&
      cachedInputs.viewBackgroundColor === appState.viewBackgroundColor &&
      cachedInputs.gridSize === appState.gridSize &&
      cachedInputs.gridStep === appState.gridStep &&
      cachedInputs.gridModeEnabled === appState.gridModeEnabled
    ) {
      return cachedSignature;
    }

    cachedInputs = {
      elements,
      files,
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      gridStep: appState.gridStep,
      gridModeEnabled: appState.gridModeEnabled,
    };

    cachedSignature = drawingSignature(elements, appState, files);
    return cachedSignature;
  };

  const persistDrawing = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
    origin: SaveOrigin = "auto",
  ) => {
    if (latestDrawing && (revision !== latestRevision || latestDrawing[0] !== elements)) {
      const [le, la, lf] = latestDrawing;
      elements = le;
      appState = la;
      files = lf;
      revision = latestRevision;
    }

    const json = serializeAsJSON(elements, appState, files, "local");
    const epochAtStart = retargetEpoch;
    savesInFlight += 1;

    try {
      const ok = await save(currentFileId, json, origin);
      lastSaveOk = ok;
      if (ok) {
        saveFailures = 0;
        if (revision === latestRevision) {
          baseline = signatureFor(elements, appState, files);
          setDirty(false);
        } else {
          setDirty(true);
        }
      } else if (revision === latestRevision) {
        setDirty(true);
        if (epochAtStart !== retargetEpoch) {
          saveFailures = 0;
          if (latestDrawing && !disposed) {
            const [le, la, lf] = latestDrawing;
            debounced(le, la, lf, latestRevision);
          }
        } else {
          saveFailures += 1;
          if (saveFailures === MAX_SAVE_RETRIES + 1) onSaveGaveUp?.(currentFileId);
          if (saveFailures <= MAX_SAVE_RETRIES && !disposed && latestDrawing) {
            const [le, la, lf] = latestDrawing;
            debounced(le, la, lf, latestRevision);
          } else if (saveFailures <= MAX_SAVE_RETRIES && !disposed) {
            debounced(elements, appState, files, revision);
          }
        }
      }

      return ok;
    } finally {
      savesInFlight -= 1;
    }
  };

  const persistLatest = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
    origin: SaveOrigin = "auto",
  ) => {
    if (blocked || disposed) return;
    await persistDrawing(elements, appState, files, revision, origin);
  };

  const debounced = debounceAsync(persistLatest, DEFAULT_AUTOSAVE_INTERVAL_MS);

  const flush = async (opts?: FlushOpts) => {
    if (disposed) return;
    runPendingEvaluation();

    const force = opts?.force === true;
    if (!force && blocked) return;
    if (!dirty && !force) {
      if (savesInFlight > 0) await debounced.flush({ force: true });
      return;
    }

    const temporarilyUnblocked = force && blocked;
    if (temporarilyUnblocked) blocked = false;

    try {
      if (force && latestDrawing) {
        debounced.cancel();
        const [elements, appState, files] = latestDrawing;
        debounced(elements, appState, files, latestRevision, "explicit");
        await debounced.flush({ force: true });
        return;
      }
      await debounced.flush({ force });
    } finally {
      if (temporarilyUnblocked) blocked = true;
    }
  };

  const saveNow = async () => {
    if (disposed || blocked || !latestDrawing) return false;

    runPendingEvaluation();

    const [elements, appState, files] = latestDrawing;
    debounced.cancel();
    debounced(elements, appState, files, latestRevision, "explicit");
    await debounced.flush({ force: true });
    return lastSaveOk;
  };

  const getSerializedContent = () => {
    if (!latestDrawing) return null;
    const [elements, appState, files] = latestDrawing;
    return serializeAsJSON(elements, appState, files, "local");
  };

  const evaluateLatest = () => {
    cancelScheduledEvaluation = null;
    if (disposed || !latestDrawing) return;

    const [elements, appState, files] = latestDrawing;
    if (appState.isLoading) return;

    const current = signatureFor(elements, appState, files);
    if (baseline === null) {
      baseline = current;
      latestSignature = current;
      if (diskBaseline != null && current !== diskBaseline) {
        latestRevision += 1;
        setDirty(true);
        void persistDrawing(elements, appState, files, latestRevision);
      }

      return;
    }

    if (current === latestSignature) return;

    latestSignature = current;
    latestRevision += 1;

    if (current === baseline && savesInFlight === 0) {
      setDirty(false);
      debounced.cancel();
      return;
    }

    setDirty(true);
    if (!blocked) debounced(elements, appState, files, latestRevision);
  };

  const scheduleEvaluation = () => {
    if (cancelScheduledEvaluation !== null || disposed) return;
    cancelScheduledEvaluation = scheduleFrame(evaluateLatest);
  };

  const runPendingEvaluation = () => {
    if (cancelScheduledEvaluation === null) return;
    cancelScheduledEvaluation();
    evaluateLatest();
  };

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (disposed) return;
    latestDrawing = [elements, appState, files];

    if (appState.isLoading) return;
    if (baseline === null) {
      evaluateLatest();
      return;
    }

    scheduleEvaluation();
  };

  const block = () => {
    blocked = true;
    debounced.pause();
  };

  const unblock = () => {
    blocked = false;
    debounced.resume();
  };

  const setAutosavePaused = (paused: boolean) => {
    if (paused) {
      block();
    } else {
      unblock();
    }
  };

  const setAutosaveInterval = (nextMs: number) => {
    if (!Number.isFinite(nextMs) || nextMs <= 0) return;
    debounced.setWait(nextMs);
  };

  const abandon = () => {
    debounced.cancel();
    saveFailures = 0;
    if (latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      baseline = signatureFor(elements, appState, files);
    }
    setDirty(false);
  };

  const ensureCleanOrConfirm = async (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => {
    runPendingEvaluation();

    if (!dirty) {
      await flush({ force: false });
      return true;
    }

    block();

    try {
      const choice = await confirmUnsaved(reason);
      if (choice === "cancel") return false;

      if (choice === "discard") {
        abandon();
        return true;
      }

      await flush({ force: true });
      return !dirty;
    } finally {
      unblock();
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;

    if (cancelScheduledEvaluation !== null) {
      cancelScheduledEvaluation();
      cancelScheduledEvaluation = null;
    }

    debounced.cancel();
  };

  return {
    onChange,
    saveNow,
    flush,
    setAutosavePaused,
    getSerializedContent,
    ensureCleanOrConfirm,
    isDirty: () => dirty,
    evaluateNow: runPendingEvaluation,
    setAutosaveInterval,
    setInitialBaseline: (signature: string | null) => {
      if (disposed || baseline !== null) return;
      diskBaseline = signature;
    },
    resetBaseline: () => {
      baseline = null;
    },
    retarget: (nextFileId: string) => {
      currentFileId = nextFileId;
      retargetEpoch += 1;
    },
    dispose,
  };
};
