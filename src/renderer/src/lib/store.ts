import { cleanErrorMessage } from "@shared/errors";
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
  FILE_NOT_FOUND_MESSAGE,
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
import { applySubtreeDelete, applySubtreeRemap, isInsideSubtree, remapId } from "@/lib/entry-tree";
import {
  parseRecentIdsJson,
  pushRecentId,
  remapRecentIds,
  removeRecentIds,
  selectRecentFiles,
} from "@/lib/recent-files";
import { sessionOwner } from "@/lib/session-owner";
import { readStoredTheme, writeStoredTheme } from "@/lib/theme";

const isOpenableFile = (
  entries: FileEntry[],
  fileId: string | null | undefined,
): fileId is string =>
  typeof fileId === "string" &&
  fileId.length > 0 &&
  entries.some((entry) => entry.id === fileId && entry.kind === "file");

const isFileNotFoundMessage = (message: string) => {
  return message === FILE_NOT_FOUND_MESSAGE || message.includes(FILE_NOT_FOUND_MESSAGE);
};

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

const isNameTaken = (entries: FileEntry[], parentId: string | null, candidate: string) =>
  entries.some((e) => e.parentId === parentId && e.name.toLowerCase() === candidate.toLowerCase());

const sameIdList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => b[i] === id);

export const nextDefaultName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  now: Date = new Date(),
) => {
  const base = kind === "directory" ? "New Folder" : `Untitled-${drawingTimestamp(now)}`;
  const suffix = kind === "directory" ? "" : ".excalidraw";

  let n = 1;
  let candidate = `${base}${suffix}`;
  while (isNameTaken(entries, parentId, candidate)) {
    n += 1;
    candidate = `${base} ${n}${suffix}`;
  }

  return candidate;
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
  editorGeneration: number;
  settings: AppSettings;
  settingsDialogOpen: boolean;
  loadSnapshot: (snapshot: DrawingsSnapshot, recentFileIdsJson?: string | null) => void;
  applyEntries: (event: FilesChangedEvent) => void;
  reportWatcherError: (event: WatcherErrorEvent) => void;
  setOpenFileId: (fileId: string | null) => Promise<void>;
  openHome: () => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<boolean>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<boolean>;
  createEntry: (parentId: string | null, kind: "file" | "directory") => Promise<string | null>;
  saveFile: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  overwriteOpenFileFromSession: () => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  setSettingsDialogOpen: (open: boolean) => void;
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

  let filesRevision = 0;

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
      if (!isFileNotFoundMessage(cleanErrorMessage(error))) {
        set({ error: toAppError(error, "save", true, id) });
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
    editorGeneration: 0,
    settingsDialogOpen: false,
    settings:
      typeof window !== "undefined"
        ? { ...DEFAULT_SETTINGS, theme: readStoredTheme(window.localStorage) }
        : DEFAULT_SETTINGS,

    loadSnapshot: (snapshot, recentFileIdsJson) => {
      resetConflicts();
      set((state) => {
        const openFileId =
          state.settings.reopenLastDrawing &&
          isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
            ? snapshot.prefs.lastOpenedFileId
            : null;

        const sanitized = selectRecentFiles(
          parseRecentIdsJson(recentFileIdsJson ?? null),
          snapshot.entries,
        ).map((entry) => entry.id);
        const recentFileIds = sanitized.length > 0 ? sanitized : openFileId ? [openFileId] : [];

        return {
          drawings: snapshot.info,
          entries: sortFileEntries(snapshot.entries),
          openFileId,
          recentFileIds,
          dirtyById: {},
          error: null,
          watcherDown: null,
          editorGeneration: state.editorGeneration + 1,
        };
      });
    },

    applyEntries: (event) => {
      const state = get();
      if (event.revision > 0 && event.revision <= filesRevision) return;
      const reduced = reduceEntries(state, event);
      syncDismissal(reduced.externalConflict);
      set({
        ...reduced,
        entries: sortFileEntries(reduced.entries),
        drawings: event.info ?? state.drawings,
        watcherDown: null,
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
        void window.api.store.set("recentFileIds", JSON.stringify(recentFileIds));
      } else {
        set({ error: null });
      }
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
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        error: null,
      });

      if (next.openFileId !== openFileId) {
        void window.api.store.set("lastOpenedFileId", next.openFileId);
      }

      if (recentChanged) {
        void window.api.store.set("recentFileIds", JSON.stringify(nextRecentFileIds));
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

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        ...(recentChanged ? { recentFileIds: nextRecentFileIds } : {}),
        error: null,
      });

      if (next.openedRemoved) void window.api.store.set("lastOpenedFileId", null);
      if (recentChanged) {
        void window.api.store.set("recentFileIds", JSON.stringify(nextRecentFileIds));
      }

      return true;
    },

    createEntry: async (parentId, kind) => {
      const name = nextDefaultName(get().entries, parentId, kind);
      const entry = await window.api.files.create(parentId, name, kind);
      set((state) => ({
        entries: sortFileEntries(upsertSorted(state.entries, entry)),
        error: null,
      }));
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

      const saved = await session.saveNow();
      if (!saved) {
        set({
          error: toAppError(
            new Error("Your changes couldn't be written to disk"),
            "save",
            true,
            openFileId,
          ),
        });
      }

      return saved;
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

    reportError: (error, operation) => set({ error: toAppError(error, operation) }),
    reportWatcherError: (event) => set({ watcherDown: event.message }),
    setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
    resolveChangedConflict,
    resolveMissingConflict,
    recoverMissingOpenFile,

    reloadOpenFileFromDisk: () => {
      const { openFileId, dirtyById, editorGeneration } = get();
      if (!openFileId) {
        set({ externalConflict: null });
        return;
      }

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
        error: null,
      });

      void window.api.store.set("lastOpenedFileId", null);
      if (recentChanged) {
        void window.api.store.set("recentFileIds", JSON.stringify(nextRecentFileIds));
      }
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
          description: toAppError(error, "unexpected", false).message,
          type: "error",
        });
        return false;
      }

      if (info === null) return false;
      if (info.path !== null && info.path === previousPath && info.configured) return true;

      sessionOwner.getSession()?.setAutosavePaused(true);
      resetConflicts();

      set({
        drawings: info,
        entries: [],
        openFileId: null,
        homeReturnFileId: null,
        dirtyById: {},
        error: null,
        watcherDown: null,
      });
      void window.api.store.set("lastOpenedFileId", null);

      try {
        const snapshot = await window.api.drawings.load();
        get().loadSnapshot(snapshot);
      } catch (error) {
        get().reportError(error, "load");
      }

      return true;
    },
  };
});
