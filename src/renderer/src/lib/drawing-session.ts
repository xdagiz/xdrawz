import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { AutosaveMode, AutosaveSetting, UnsavedChoice, UnsavedReason } from "@shared/ipc";
import { DEFAULT_AUTOSAVE, autosaveDebounceMs, autosaveWaitMs } from "@shared/ipc";

import { debounceAsync } from "@/lib/debounce";

export const MAX_SAVE_RETRIES = 3;

export type SaveOrigin = "auto" | "explicit";

type DrawingSnapshot = [readonly OrderedExcalidrawElement[], AppState, BinaryFiles];

type FlushOpts = {
  force?: boolean;
  explicit?: boolean;
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
  markPersisted: () => void;
  retarget: (nextFileId: string) => void;
  ensureCleanOrConfirm: (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => Promise<boolean>;
  isDirty: () => boolean;
  evaluateNow: () => void;
  setAutosaveMode: (next: AutosaveSetting) => void;
  dispose: () => void;
};

type DrawingSessionDeps = {
  fileId: string;
  save: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onSaveGaveUp?: (fileId: string) => void;
  initialBaseline?: string | null;
  initialAutosave?: AutosaveSetting;
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
    initialAutosave = DEFAULT_AUTOSAVE,
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
  let saveSeq = 0;
  let appliedSeq = 0;
  let disposed = false;
  let blocked = false;
  let dirty = false;
  let dirtyPublished = false;
  let mode: AutosaveMode = initialAutosave.mode;
  let saveFailures = 0;
  let saveNowTail: Promise<void> = Promise.resolve();
  let explicitSaveInFlight = false;
  let cancelScheduledEvaluation: (() => void) | null = null;

  const setDirty = (next: boolean) => {
    dirty = next;
    const visible = mode === "always" ? false : next;
    if (dirtyPublished === visible) return;
    dirtyPublished = visible;
    onDirtyChange?.(currentFileId, visible);
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

  type SaveTarget = {
    snapshot: DrawingSnapshot;
    revision: number;
  };

  type SaveFailure = SaveTarget & {
    epochAtStart: number;
  };

  const resolveTarget = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
  ): SaveTarget => {
    if (latestDrawing && (revision !== latestRevision || latestDrawing[0] !== elements)) {
      return { snapshot: latestDrawing, revision: latestRevision };
    }
    return { snapshot: [elements, appState, files], revision };
  };

  const retryLatest = () => {
    if (!latestDrawing || disposed) return;
    const [le, la, lf] = latestDrawing;
    debounced(le, la, lf, latestRevision);
  };

  const retryAfterSaveFailure = ({ snapshot, revision, epochAtStart }: SaveFailure) => {
    if (disposed) return;
    setDirty(true);
    if (epochAtStart !== retargetEpoch) {
      saveFailures = 0;
      retryLatest();
      return;
    }

    saveFailures += 1;
    if (saveFailures === MAX_SAVE_RETRIES + 1) onSaveGaveUp?.(currentFileId);
    if (saveFailures > MAX_SAVE_RETRIES || disposed) {
      if (saveFailures > MAX_SAVE_RETRIES) debounced.cancel();
      return;
    }

    if (latestDrawing) {
      retryLatest();
      return;
    }

    const [elements, appState, files] = snapshot;
    debounced(elements, appState, files, revision);
  };

  const persistDrawing = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
    origin: SaveOrigin = "auto",
  ) => {
    const { snapshot: targetSnapshot, revision: targetRevision } = resolveTarget(
      elements,
      appState,
      files,
      revision,
    );
    const [targetElements, targetAppState, targetFiles] = targetSnapshot;

    const epochAtStart = retargetEpoch;
    const mySeq = ++saveSeq;
    savesInFlight += 1;

    try {
      const json = serializeAsJSON(targetElements, targetAppState, targetFiles, "local");
      const ok = await save(currentFileId, json, origin);
      if (mySeq <= appliedSeq || disposed) return ok;
      appliedSeq = mySeq;
      if (ok) {
        saveFailures = 0;
        if (targetRevision === latestRevision && epochAtStart === retargetEpoch) {
          baseline = signatureFor(targetElements, targetAppState, targetFiles);
          setDirty(false);
        } else {
          setDirty(true);
          if (
            targetRevision === latestRevision &&
            epochAtStart !== retargetEpoch &&
            latestDrawing &&
            !disposed
          ) {
            retryLatest();
          }
        }
      } else if (targetRevision === latestRevision) {
        retryAfterSaveFailure({
          snapshot: targetSnapshot,
          revision: targetRevision,
          epochAtStart,
        });
      }

      return ok;
    } catch {
      if (mySeq <= appliedSeq || disposed) return false;
      appliedSeq = mySeq;
      if (targetRevision === latestRevision) {
        retryAfterSaveFailure({
          snapshot: targetSnapshot,
          revision: targetRevision,
          epochAtStart,
        });
      }

      return false;
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

  const debounced = debounceAsync(persistLatest, autosaveWaitMs(initialAutosave));

  const flush = async (opts?: FlushOpts) => {
    if (disposed) return;

    const force = opts?.force === true;
    const explicit = opts?.explicit === true;
    if (mode === "off" && !explicit) return;

    runPendingEvaluation();
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
    if (!latestDrawing) return false;

    debounced.cancel();
    const run = async (): Promise<boolean> => {
      const current = latestDrawing;
      if (!current || disposed) return false;
      const [currentElements, currentAppState, currentFiles] = current;
      return persistDrawing(
        currentElements,
        currentAppState,
        currentFiles,
        latestRevision,
        "explicit",
      );
    };
    if (!explicitSaveInFlight) {
      explicitSaveInFlight = true;
      const started = run();
      saveNowTail = started.then(
        () => undefined,
        () => undefined,
      );
      const drain = async () => {
        try {
          let observed = saveNowTail;
          for (;;) {
            await observed;
            if (observed === saveNowTail) break;
            observed = saveNowTail;
          }
        } finally {
          explicitSaveInFlight = false;
        }
      };
      void drain();
      return started;
    }
    const queued = saveNowTail.then(run);
    saveNowTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
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
        console.debug("[session] first evaluate persisted normalized baseline");
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
    if (mode === "off") return;
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
    if (disposed || appState.isLoading) return;
    latestDrawing = [elements, appState, files];

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

  const setAutosaveMode = (next: AutosaveSetting) => {
    const prev = mode;
    mode = next.mode;
    if (next.mode !== "off") debounced.setWait(autosaveDebounceMs(next));
    if (next.mode === "off") debounced.cancel();
    setDirty(latestSignature !== null && latestSignature !== baseline);
    if (next.mode !== "off" && prev === "off" && !blocked && !disposed && dirty && latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      debounced(elements, appState, files, latestRevision);
    }
  };

  const abandon = () => {
    debounced.cancel();
    saveFailures = 0;
    if (latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      baseline = signatureFor(elements, appState, files);
    }
    latestSignature = baseline;
    setDirty(false);
  };

  const markPersisted = () => {
    debounced.cancel();
    saveFailures = 0;
    appliedSeq = saveSeq;
    if (latestDrawing) {
      const [elements, appState, files] = latestDrawing;
      baseline = signatureFor(elements, appState, files);
      latestSignature = baseline;
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

      await flush({ force: true, explicit: true });
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
    latestDrawing = null;
    latestSignature = null;
    cachedInputs = null;
    cachedSignature = "";
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
    setAutosaveMode,
    setInitialBaseline: (signature: string | null) => {
      if (disposed || baseline !== null) return;
      diskBaseline = signature;
    },
    resetBaseline: () => {
      baseline = null;
    },
    markPersisted,
    retarget: (nextFileId: string) => {
      currentFileId = nextFileId;
      retargetEpoch += 1;
    },
    dispose,
  };
};
