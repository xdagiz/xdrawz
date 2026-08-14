import { serializeAsJSON } from "@excalidraw/excalidraw";
import { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { UnsavedChoice, UnsavedReason } from "@shared/ipc";

import { debounceAsync } from "@/lib/debounce";

export const AUTOSAVE_MS = 5_000;

export const MAX_SAVE_RETRIES = 3;

type SceneSnapshot = [readonly OrderedExcalidrawElement[], AppState, BinaryFiles];

type FlushOpts = {
  force?: boolean;
};

export type SceneSessionControls = {
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
  ensureCleanOrConfirm: (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => Promise<boolean>;
  isDirty: () => boolean;
  dispose: () => void;
};

type SceneSessionDeps = {
  fileId: string;
  save: (id: string, content: string) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  initialBaseline?: string | null;
};

export const sceneSignature = (
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

export const createSceneSession = (deps: SceneSessionDeps): SceneSessionControls => {
  const { fileId, save, onDirtyChange, initialBaseline = null } = deps;

  let baseline: string | null = null;
  let diskBaseline = initialBaseline;
  let latestScene: SceneSnapshot | null = null;
  let latestSignature: string | null = null;
  let latestRevision = 0;
  let savesInFlight = 0;
  let disposed = false;
  let blocked = false;
  let dirty = false;
  let saveFailures = 0;
  let lastSaveOk = false;

  const setDirty = (next: boolean) => {
    if (dirty === next) return;
    dirty = next;
    onDirtyChange?.(fileId, next);
  };

  const persistScene = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
    revision: number,
  ) => {
    const json = serializeAsJSON(elements, appState, files, "local");
    savesInFlight += 1;

    try {
      const ok = await save(fileId, json);
      lastSaveOk = ok;
      if (ok) {
        saveFailures = 0;
        if (revision === latestRevision) {
          baseline = sceneSignature(elements, appState, files);
          setDirty(false);
        } else {
          setDirty(true);
        }
      } else if (revision === latestRevision) {
        setDirty(true);
        saveFailures += 1;
        if (saveFailures <= MAX_SAVE_RETRIES && !disposed) {
          debounced(elements, appState, files, revision);
        }
      }

      return ok;
    } finally {
      savesInFlight -= 1;
    }
  };

  const debounced = debounceAsync(
    async (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
      revision: number,
    ) => {
      if (blocked || disposed) return;
      await persistScene(elements, appState, files, revision);
    },
    AUTOSAVE_MS,
  );

  const flush = async (opts?: FlushOpts) => {
    if (disposed) return;
    const force = opts?.force === true;
    if (!force && blocked) return;
    if (!dirty && !force) return;

    const temporarilyUnblocked = force && blocked;
    if (temporarilyUnblocked) blocked = false;

    try {
      await debounced.flush({ force });
    } finally {
      if (temporarilyUnblocked) blocked = true;
    }
  };

  const saveNow = async () => {
    if (disposed || blocked || !latestScene || diskBaseline === null) return false;

    const [elements, appState, files] = latestScene;
    debounced(elements, appState, files, latestRevision);

    await debounced.flush({ force: true });
    return lastSaveOk;
  };

  const getSerializedContent = () => {
    if (!latestScene) return null;
    const [elements, appState, files] = latestScene;
    return serializeAsJSON(elements, appState, files, "local");
  };

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (disposed) return;
    latestScene = [elements, appState, files];

    if (appState.isLoading) return;

    const current = sceneSignature(elements, appState, files);
    if (baseline === null) {
      baseline = current;
      latestSignature = current;
      if (diskBaseline != null && current !== diskBaseline) {
        latestRevision += 1;
        setDirty(true);
        void persistScene(elements, appState, files, latestRevision);
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

  const block = () => {
    blocked = true;
    debounced.pause();
  };

  const unblock = () => {
    blocked = false;
    debounced.resume();
  };

  const setAutosavePaused = (paused: boolean) => {
    if (paused) block();
    else unblock();
  };

  const abandon = () => {
    debounced.cancel();
    saveFailures = 0;
    if (latestScene) {
      const [elements, appState, files] = latestScene;
      baseline = sceneSignature(elements, appState, files);
    }
    setDirty(false);
  };

  const ensureCleanOrConfirm = async (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => {
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
    setInitialBaseline: (signature: string | null) => {
      if (disposed || baseline !== null) return;
      diskBaseline = signature;
    },
    resetBaseline: () => {
      baseline = null;
    },
    dispose,
  };
};
