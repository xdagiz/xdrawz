import { serializeAsJSON } from "@excalidraw/excalidraw";
import { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { UnsavedChoice, UnsavedReason } from "@shared/ipc";

import { debounceAsync } from "@/lib/debounce";

export const AUTOSAVE_MS = 5_000;

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
  saveNow: () => Promise<void>;
  flush: (opts?: FlushOpts) => Promise<void>;
  getSerializedContent: () => string | null;
  ensureCleanOrConfirm: (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ) => Promise<boolean>;
  isDirty: () => boolean;
  setInitialBaseline: (signature: string | null) => void;
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
  let disposed = false;
  let blocked = false;
  let dirty = false;

  const setDirty = (next: boolean) => {
    if (dirty === next) return;
    dirty = next;
    onDirtyChange?.(fileId, next);
  };

  const persistScene = async (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const json = serializeAsJSON(elements, appState, files, "local");
    const ok = await save(fileId, json);

    if (ok) {
      baseline = sceneSignature(elements, appState, files);
      setDirty(false);
    } else {
      setDirty(true);
    }

    return ok;
  };

  const debounced = debounceAsync(
    async (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (blocked || disposed) return;
      await persistScene(elements, appState, files);
    },
    AUTOSAVE_MS,
  );

  const flush = async (opts?: FlushOpts) => {
    if (disposed) return;
    const force = opts?.force === true;
    if (!force && blocked) return;

    await debounced.flush({ force });

    if (force && dirty && latestScene) {
      const [elements, appState, files] = latestScene;
      await persistScene(elements, appState, files);
    }
  };

  const saveNow = async () => {
    if (disposed || blocked) return;
    debounced.cancel();

    if (!latestScene) return;

    const [elements, appState, files] = latestScene;
    await persistScene(elements, appState, files);
  };

  const getSerializedContent = (): string | null => {
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
      if (diskBaseline != null && current !== diskBaseline) {
        void persistScene(elements, appState, files);
      }

      return;
    }

    if (current === baseline) {
      setDirty(false);
      debounced.cancel();
      return;
    }

    setDirty(true);
    if (!blocked) debounced(elements, appState, files);
  };

  const block = () => {
    blocked = true;
    debounced.pause();
  };

  const unblock = () => {
    blocked = false;
    debounced.resume();
  };

  const abandon = () => {
    debounced.cancel();
    if (latestScene) {
      const [elements, appState, files] = latestScene;
      baseline = sceneSignature(elements, appState, files);
    }
    setDirty(false);
  };

  const ensureCleanOrConfirm = async (
    reason: UnsavedReason,
    confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>,
  ): Promise<boolean> => {
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
    getSerializedContent,
    ensureCleanOrConfirm,
    isDirty: () => dirty,
    setInitialBaseline: (signature: string | null) => {
      if (disposed || baseline !== null) return;
      diskBaseline = signature;
    },
    dispose,
  };
};
