import { codedError, isNotFoundError } from "@shared/errors";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  FileEntry,
  FilesChangedEvent,
  SettingsUpdate,
  UnsavedReason,
  WatcherErrorEvent,
} from "@shared/ipc";
import {
  DEFAULT_SETTINGS,
  compareEntryIds,
  type FileDeleteMode,
  sortFileEntries,
} from "@shared/ipc";
import { create } from "zustand";

import { toast } from "@/components/ui/toast";
import { saveErrorToastId, toAppError, type AppError } from "@/lib/app-error";
import { createConflictResolver } from "@/lib/conflict-resolution";
import { reduceEntries, removeKey, type ExternalConflict } from "@/lib/conflicts";
import type { SaveOrigin } from "@/lib/drawing-session";
import {
  applySubtreeDelete,
  applySubtreeRemap,
  isInsideSubtree,
  remapId,
  remapNullableId,
} from "@/lib/entry-tree";
import { pushRecentId, remapRecentIds, removeRecentIds } from "@/lib/recent-files";
import { sessionOwner } from "@/lib/session-owner";
import { readStoredTheme, writeStoredTheme } from "@/lib/theme";

const isOpenableFile = (
  entries: FileEntry[],
  fileId: string | null | undefined,
): fileId is string =>
  typeof fileId === "string" &&
  fileId.length > 0 &&
  entries.some((entry) => entry.id === fileId && entry.kind === "file");

const upsertSorted = (entries: FileEntry[], entry: FileEntry, removeId = entry.id): FileEntry[] => {
  const withoutOld = entries.filter((e) => e.id !== removeId);

  let low = 0;
  let high = withoutOld.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareEntryIds(withoutOld[mid].id, entry.id) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const next = [...withoutOld];
  next.splice(low, 0, entry);

  return next;
};

const pad2 = (value: number) => `${value}`.padStart(2, "0");

export const drawingTimestamp = (date: Date) => {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hr = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `${year}-${month}-${day}-${hr}${min}`;
};

export const isNameTaken = (entries: FileEntry[], parentId: string | null, candidate: string) => {
  return entries.some((e) => e.parentId === parentId && e.name === candidate);
};

const sameIdList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => b[i] === id);

export const nextDefaultName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  now: Date = new Date(),
) => {
  const nameSet = new Set(entries.filter((e) => e.parentId === parentId).map((e) => e.name));
  const base = kind === "directory" ? "New Folder" : `Untitled-${drawingTimestamp(now)}`;
  const suffix = kind === "directory" ? "" : ".excalidraw";

  let n = 1;
  let candidate = `${base}${suffix}`;
  while (nameSet.has(candidate)) {
    n += 1;
    candidate = `${base} ${n}${suffix}`;
  }

  return candidate;
};

export const resolveEntryName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  requestedName?: string,
) => {
  const trimmed = requestedName?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return nextDefaultName(entries, parentId, kind);
};

export type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
  recentFileIds: string[];
  homeReturnFileId: string | null;
  dirtyById: Record<string, true>;
  error: AppError | null;
  externalConflict: ExternalConflict;
  watcherDown: string | null;
  isLoadingDrawings: boolean;
  pendingCanvasAction: boolean;
  scratchUnsaved: boolean;
  editorGeneration: number;
  settings: AppSettings;
  settingsDialogOpen: boolean;
  paletteOpen: boolean;
  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  applyEntries: (event: FilesChangedEvent) => void;
  reportWatcherError: (event: WatcherErrorEvent) => void;
  setOpenFileId: (fileId: string | null) => Promise<void>;
  openReservedFile: (fileId: string) => Promise<boolean>;
  openHome: () => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<boolean>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<boolean>;
  createEntry: (
    parentId: string | null,
    kind: "file" | "directory",
    requestedName?: string,
  ) => Promise<string | null>;
  createFileWithContent: (
    parentId: string | null,
    fileName: string,
    content: string,
  ) => Promise<string | null>;
  createAndOpenEntry: (
    parentId: string | null,
    kind: "file" | "directory",
    requestedName?: string,
  ) => Promise<string | null>;
  saveFile: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  overwriteOpenFileFromSession: () => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  setPendingCanvasAction: (pending: boolean) => void;
  setScratchUnsaved: (pending: boolean) => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  reportError: (error: unknown, operation: "load" | "save" | "recover" | "settings") => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
  resolveChangedConflict: (opts?: {
    force?: boolean;
  }) => Promise<"reload" | "overwrite" | "cancel">;
  recoverMissingOpenFile: () => Promise<boolean>;
  resolveMissingConflict: (
    content?: string,
    opts?: { force?: boolean },
  ) => Promise<"recover" | "discard" | "cancel">;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
  initSettings: () => Promise<void>;
  updateSettings: (updated: SettingsUpdate) => Promise<boolean>;
  pickAndSwitchFolder: () => Promise<boolean>;
};

export const useStore = create<State>((set, get) => {
  const {
    gateConflictedSave,
    recoverMissingOpenFile,
    resolveChangedConflict,
    resolveMissingConflict,
    resetConflicts,
    clearDismissalIfOwned,
    syncDismissal,
  } = createConflictResolver({
    get: () => {
      const s = get();
      return {
        rootPath: s.drawings?.path ?? null,
        editorGeneration: s.editorGeneration,
        entries: s.entries,
        openFileId: s.openFileId,
        dirtyById: s.dirtyById,
        error: s.error,
        externalConflict: s.externalConflict,
      };
    },
    set: (patch) => set(patch),
    reloadOpenFileFromDisk: () => get().reloadOpenFileFromDisk(),
    discardMissingOpenFile: () => get().discardMissingOpenFile(),
    commitEntries: sortFileEntries,
  });

  let filesRevision = -1;

  const persistDrawingToDisk = async (id: string, content: string, origin: SaveOrigin) => {
    try {
      const savedEntry = await window.api.files.write(id, content);
      const latest = get();
      const ownsConflict = clearDismissalIfOwned(id);
      set({
        error: null,
        ...(ownsConflict ? { externalConflict: null } : {}),
        entries: sortFileEntries(upsertSorted(latest.entries, savedEntry)),
      });
      toast.close(saveErrorToastId(id));
      return true;
    } catch (error) {
      if (!isNotFoundError(error)) {
        set({ error: toAppError(error, "save", { resourceId: id }) });
        return false;
      }

      const latest = get();
      if (latest.externalConflict?.type !== "missing" || latest.externalConflict.fileId !== id) {
        set({ externalConflict: { type: "missing", fileId: id } });
      }

      if (origin !== "explicit") return false;

      const choice = await get().resolveMissingConflict(content, { force: true });
      return choice !== "cancel";
    }
  };

  return {
    drawings: null,
    entries: [],
    openFileId: null,
    recentFileIds: [],
    homeReturnFileId: null,
    dirtyById: {},
    error: null,
    externalConflict: null,
    watcherDown: null,
    isLoadingDrawings: true,
    pendingCanvasAction: false,
    scratchUnsaved: false,
    editorGeneration: 0,
    settingsDialogOpen: false,
    paletteOpen: false,
    settings:
      typeof window !== "undefined"
        ? { ...DEFAULT_SETTINGS, theme: readStoredTheme(window.localStorage) }
        : DEFAULT_SETTINGS,

    loadSnapshot: (snapshot) => {
      resetConflicts();
      filesRevision = -1;
      set((state) => {
        const openFileId =
          state.settings.reopenLastDrawing &&
          isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
            ? snapshot.prefs.lastOpenedFileId
            : null;

        return {
          drawings: snapshot.info,
          entries: sortFileEntries(snapshot.entries),
          openFileId,
          recentFileIds: openFileId ? [openFileId] : [],
          dirtyById: {},
          error: null,
          watcherDown: null,
          isLoadingDrawings: false,
          pendingCanvasAction: false,
          scratchUnsaved: false,
          editorGeneration: state.editorGeneration + 1,
        };
      });
    },

    applyEntries: (event) => {
      if (event.revision > 0 && event.revision <= filesRevision) return;
      const openFileId = get().openFileId;
      const session = openFileId !== null ? sessionOwner.getSession(openFileId) : null;
      session?.evaluateNow();
      const state = get();
      const openFileDirty =
        session?.isDirty() ?? (openFileId !== null && state.dirtyById[openFileId] !== undefined);
      const reduced = reduceEntries(state, event, openFileDirty);
      syncDismissal(reduced.externalConflict);
      const eventIds = event.root === null ? null : new Set(event.entries.map((entry) => entry.id));
      const prunedRecentFileIds =
        eventIds === null
          ? state.recentFileIds
          : removeRecentIds(state.recentFileIds, (rid) => !eventIds.has(rid));
      const recentsChanged = prunedRecentFileIds.length !== state.recentFileIds.length;
      set({
        ...reduced,
        entries: sortFileEntries(reduced.entries),
        drawings: event.info ?? state.drawings,
        watcherDown: null,
        ...(recentsChanged ? { recentFileIds: prunedRecentFileIds } : {}),
      });
      filesRevision = event.revision;
    },

    setOpenFileId: async (fileId) => {
      const current = get().openFileId;
      if (fileId === current) return;

      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return;

      if (fileId === null) {
        set({ openFileId: null, error: null, externalConflict: null });
        void window.api.store.set("lastOpenedFileId", null);
      } else if (isOpenableFile(get().entries, fileId)) {
        const recentFileIds = pushRecentId(get().recentFileIds, fileId);
        set({
          openFileId: fileId,
          error: null,
          externalConflict: null,
          recentFileIds,
          editorGeneration: get().editorGeneration + 1,
        });
        void window.api.store.set("lastOpenedFileId", fileId);
      } else {
        const staleRecentFileIds = removeRecentIds(get().recentFileIds, (rid) => rid === fileId);
        set({
          error: null,
          ...(staleRecentFileIds.length !== get().recentFileIds.length
            ? { recentFileIds: staleRecentFileIds }
            : {}),
        });
        toast.add({
          title: "Couldn’t open drawing",
          description: "The file no longer exists.",
          type: "error",
        });
      }
    },

    openReservedFile: async (fileId) => {
      const current = get().openFileId;
      if (fileId === current) return true;

      if (sessionOwner.getActiveFileId() === fileId) {
        if (!isOpenableFile(get().entries, fileId)) {
          set({ pendingCanvasAction: false, scratchUnsaved: false });
          return false;
        }

        const recentFileIds = pushRecentId(get().recentFileIds, fileId);
        set({
          openFileId: fileId,
          error: null,
          externalConflict: null,
          recentFileIds,
          pendingCanvasAction: false,
          scratchUnsaved: false,
        });

        void window.api.store.set("lastOpenedFileId", fileId);
        return true;
      }

      await get().setOpenFileId(fileId);
      return true;
    },

    openHome: async () => {
      const current = get().openFileId;
      if (current === null) return;
      await get().setOpenFileId(null);
      if (get().openFileId === null) set({ homeReturnFileId: current });
    },

    renameEntry: async (id, newName) => {
      const openId = get().openFileId;
      if (isInsideSubtree(id, openId) && get().dirtyById[openId]) {
        const ok = await get().ensureCleanOrConfirm("switch");
        if (!ok) return false;
      }

      const entry = await window.api.files.rename(id, newName);
      const activeSessionFileId = sessionOwner.getActiveFileId();
      if (activeSessionFileId) {
        const remappedActive = remapId(activeSessionFileId, id, entry.id);
        if (remappedActive !== activeSessionFileId) {
          sessionOwner.retargetActive(activeSessionFileId, remappedActive);
        }
      }

      const { entries, openFileId, dirtyById, recentFileIds } = get();
      const next = applySubtreeRemap({ entries, openFileId, dirtyById }, id, entry.id, {
        rootEntry: entry,
        sort: true,
      });

      const pairs = new Map<string, string>();
      for (const e of entries) {
        const mapped = remapId(e.id, id, entry.id);
        if (mapped !== e.id) pairs.set(e.id, mapped);
      }

      const nextRecentFileIds = remapRecentIds(recentFileIds, (rid) => pairs.get(rid) ?? rid);
      const recentChanged = !sameIdList(nextRecentFileIds, recentFileIds);

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        homeReturnFileId: remapNullableId(get().homeReturnFileId, id, entry.id),
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        error: null,
      });

      if (next.openFileId !== openFileId) {
        void window.api.store.set("lastOpenedFileId", next.openFileId);
      }

      return true;
    },

    deleteEntry: async (id, mode) => {
      const { openFileId, dirtyById } = get();

      if (
        isInsideSubtree(id, openFileId) &&
        Object.prototype.hasOwnProperty.call(dirtyById, openFileId)
      ) {
        toast.add({
          title: "Couldn’t delete",
          description: "The folder contains the open drawing with unsaved changes. Close it first.",
          type: "error",
        });
        return false;
      }

      await window.api.files.delete(id, mode);

      const { entries, recentFileIds } = get();
      const next = applySubtreeDelete({ entries, openFileId, dirtyById }, id);
      const nextRecentFileIds = removeRecentIds(recentFileIds, (rid) => isInsideSubtree(id, rid));
      const recentChanged = nextRecentFileIds.length !== recentFileIds.length;
      const homeReturnFileId = get().homeReturnFileId;

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        homeReturnFileId:
          homeReturnFileId && isInsideSubtree(id, homeReturnFileId) ? null : homeReturnFileId,
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        ...(next.openFileId !== openFileId ? { editorGeneration: get().editorGeneration + 1 } : {}),
        error: null,
      });

      if (next.openedRemoved) void window.api.store.set("lastOpenedFileId", null);

      return true;
    },

    createEntry: async (parentId, kind, requestedName) => {
      const name = resolveEntryName(get().entries, parentId, kind, requestedName);
      const entry = await window.api.files.create(parentId, name, kind);
      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        error: null,
      }));
      return entry.id;
    },

    createFileWithContent: async (parentId, fileName, content) => {
      const entry = await window.api.files.create(parentId, fileName, "file");
      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        error: null,
      }));

      const saved = await get().saveFile(entry.id, content, "explicit");
      if (!saved) {
        await window.api.files.delete(entry.id, "permanent").catch(() => undefined);
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== entry.id),
        }));
        return null;
      }

      return entry.id;
    },

    createAndOpenEntry: async (parentId, kind, requestedName) => {
      if (kind === "file") {
        const okToSwitch = await get().ensureCleanOrConfirm("switch");
        if (!okToSwitch) return null;
      }

      const name = resolveEntryName(get().entries, parentId, kind, requestedName);

      const entry = await window.api.files.create(parentId, name, kind);
      if (kind !== "file") {
        set((state) => ({
          entries: sortFileEntries(upsertSorted(state.entries, entry)),
          error: null,
        }));
        return entry.id;
      }

      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        openFileId: entry.id,
        recentFileIds: pushRecentId(state.recentFileIds, entry.id),
        error: null,
        externalConflict: null,
        editorGeneration: state.editorGeneration + 1,
      }));

      void window.api.store.set("lastOpenedFileId", entry.id);
      return entry.id;
    },

    saveFile: async (id, content, origin = "auto") => {
      if (!id) return false;
      const gate = await gateConflictedSave(id, content, origin);
      if (gate.action === "stop") return gate.result;
      return persistDrawingToDisk(id, content, origin);
    },

    overwriteOpenFileFromSession: async () => {
      const { openFileId, externalConflict } = get();
      if (!openFileId || externalConflict) return false;

      const session = sessionOwner.getSession();
      if (!session) return false;

      const result = await session.saveNow({ force: true });
      if (result === "failed") {
        set({
          error: toAppError(
            codedError("Your changes couldn't be written to disk", {
              code: "UNKNOWN",
              reason: "io",
            }),
            "save",
            {
              resourceId: openFileId,
            },
          ),
        });
      }

      return result === "saved" || result === "saved-with-changes";
    },

    setFileDirty: (id, dirty) => {
      if (!id) return;
      set((state) => {
        if (dirty) {
          if (state.dirtyById[id]) return state;
          return { dirtyById: { ...state.dirtyById, [id]: true } };
        }

        if (!state.dirtyById[id]) return state;
        const next = { ...state.dirtyById };
        delete next[id];

        return { dirtyById: next };
      });
    },

    setPendingCanvasAction: (pending) => set({ pendingCanvasAction: pending }),
    setScratchUnsaved: (pending) => set({ scratchUnsaved: pending }),

    reportError: (error, operation) =>
      set({
        error: toAppError(error, operation),
        ...(operation === "load" ? { isLoadingDrawings: false } : {}),
      }),
    reportWatcherError: (event) => set({ watcherDown: event.message }),
    setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
    setPaletteOpen: (open) => set({ paletteOpen: open }),
    resolveChangedConflict,
    resolveMissingConflict,
    recoverMissingOpenFile,

    reloadOpenFileFromDisk: () => {
      const { openFileId, dirtyById, editorGeneration } = get();
      if (!openFileId) {
        set({ externalConflict: null });
        return;
      }

      sessionOwner.getSession(openFileId)?.invalidate();
      set({
        externalConflict: null,
        dirtyById: removeKey(dirtyById, openFileId),
        editorGeneration: editorGeneration + 1,
        error: null,
      });
    },

    discardMissingOpenFile: () => {
      const { openFileId, dirtyById, recentFileIds } = get();
      const nextRecentFileIds = openFileId
        ? removeRecentIds(recentFileIds, (rid) => rid === openFileId)
        : recentFileIds;
      const recentChanged = nextRecentFileIds.length !== recentFileIds.length;

      set({
        openFileId: null,
        externalConflict: null,
        dirtyById: openFileId ? removeKey(dirtyById, openFileId) : dirtyById,
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        ...(openFileId ? { editorGeneration: get().editorGeneration + 1 } : {}),
        error: null,
      });

      void window.api.store.set("lastOpenedFileId", null);
    },

    ensureCleanOrConfirm: async (reason = "switch") => {
      const session = sessionOwner.getSession();
      if (!session) {
        const id = get().openFileId;
        return !id || !get().dirtyById[id];
      }

      return session.ensureCleanOrConfirm(reason);
    },

    initSettings: async () => {
      try {
        const settings = await window.api.settings.get();
        writeStoredTheme(window.localStorage, settings.theme);
        set({ settings });
      } catch (error) {
        console.error("failed to load settings:", error);
        toast.add({
          title: "Couldn’t load settings",
          description: "Your saved preferences couldn’t be loaded.",
          type: "warning",
        });
      }
    },

    updateSettings: async (updated) => {
      const settings = await window.api.settings.update(updated);
      writeStoredTheme(window.localStorage, settings.theme);
      set({ settings });
      return true;
    },

    pickAndSwitchFolder: async () => {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;

      const previousPath = get().drawings?.path ?? null;

      let info: DrawingInfo | null = null;
      try {
        info = await window.api.drawings.pick();
      } catch (error) {
        toast.add({
          title: "Couldn’t choose the drawings folder",
          description: toAppError(error, "unexpected").detail,
          type: "error",
        });
        return false;
      }

      if (info === null) return false;
      if (info.path !== null && info.path === previousPath && info.configured) return true;

      const pausedSession = sessionOwner.getSession();
      pausedSession?.setAutosavePaused(true);
      try {
        resetConflicts();
        filesRevision = -1;

        set({
          drawings: info,
          entries: [],
          openFileId: null,
          homeReturnFileId: null,
          dirtyById: {},
          error: null,
          watcherDown: null,
          isLoadingDrawings: true,
        });
        void window.api.store.set("lastOpenedFileId", null);

        try {
          const snapshot = await window.api.drawings.load();
          get().loadSnapshot(snapshot);
        } catch (error) {
          get().reportError(error, "load");
        }
      } finally {
        pausedSession?.setAutosavePaused(false);
      }

      return true;
    },
  };
});
