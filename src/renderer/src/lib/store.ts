import { cleanErrorMessage } from "@shared/errors";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  ExternalConflict,
  FileEntry,
  FilesChangedEvent,
  SettingsUpdate,
  UnsavedReason,
  WatcherErrorEvent,
} from "@shared/ipc";
import {
  DEFAULT_SETTINGS,
  FILE_NOT_FOUND_MESSAGE,
  parentIdOf,
  type FileDeleteMode,
  type SaveOrigin,
} from "@shared/ipc";
import { create } from "zustand";

import { toast } from "@/components/ui/toast";
import { toAppError, type AppError } from "@/lib/app-error";
import { conflictKeyOf, createSingleFlight, fileNameOf, reduceEntries } from "@/lib/conflicts";
import { applySubtreeDelete, applySubtreeRemap, isInsideSubtree } from "@/lib/entry-tree";
import { sessionOwner } from "@/lib/session-owner";
import { readStoredTheme, writeStoredTheme } from "@/lib/theme";

const isOpenableFile = (
  entries: FileEntry[],
  fileId: string | null | undefined,
): fileId is string =>
  typeof fileId === "string" &&
  fileId.length > 0 &&
  entries.some((entry) => entry.id === fileId && entry.kind === "file");

const removeKey = (obj: Record<string, true>, key: string): Record<string, true> => {
  const next = { ...obj };
  delete next[key];
  return next;
};

const isFileNotFoundMessage = (message: string) => {
  return message === FILE_NOT_FOUND_MESSAGE || message.includes(FILE_NOT_FOUND_MESSAGE);
};

const upsertSorted = (entries: FileEntry[], entry: FileEntry, removeId = entry.id): FileEntry[] => {
  const withoutOld = entries.filter((e) => e.id !== removeId);
  let low = 0;
  let high = withoutOld.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (withoutOld[mid].id.localeCompare(entry.id, undefined, { sensitivity: "base" }) < 0) {
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

export const drawingTimestamp = (date: Date): string => {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hr = pad2(date.getHours());
  const min = pad2(date.getMinutes());

  return `${year}-${month}-${day}-${hr}${min}`;
};

const isNameTaken = (entries: FileEntry[], parentId: string | null, candidate: string) =>
  entries.some((e) => e.parentId === parentId && e.name.toLowerCase() === candidate.toLowerCase());

export const nextDefaultName = (
  entries: FileEntry[],
  parentId: string | null,
  kind: "file" | "directory",
  now: Date = new Date(),
): string => {
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

const runChangedDialog = createSingleFlight<"reload" | "overwrite" | "cancel">();
const runRecoverDialog = createSingleFlight<"recover" | "discard" | "cancel">();
let pendingRecoverContent: string | undefined;

const savedAfterDisk = (diskModifiedAt: number, savedAt: number) =>
  Math.max(diskModifiedAt + 1, savedAt);

const entryAfterWrite = (id: string, content: string, entries: FileEntry[]): FileEntry => {
  const existing = entries.find((e) => e.id === id);
  const now = Date.now();
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const size = new Blob([normalized]).size;
  if (existing) {
    return {
      ...existing,
      modifiedAt: savedAfterDisk(existing.modifiedAt, now),
      size,
    };
  }
  return {
    id,
    name: id.split("/").pop() ?? id,
    kind: "file",
    parentId: parentIdOf(id),
    modifiedAt: now,
    size,
  };
};

const performRecover = async (fileId: string, body: string) => {
  try {
    await window.api.files.writeRecover(fileId, body);
    const entries = await window.api.files.list();
    useStore.setState({
      error: null,
      externalConflict: null,
      entries,
      dirtyById: removeKey(useStore.getState().dirtyById, fileId),
    });
    return true;
  } catch (err) {
    useStore.setState({ error: toAppError(err, "recover") });
    return false;
  }
};

type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  error: AppError | null;
  filesRevision: number;
  externalConflict: ExternalConflict;
  watcherDown: string | null;
  editorEpoch: number;
  dismissedConflictKey: string | null;
  settings: AppSettings;
  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  applyEntries: (event: FilesChangedEvent) => void;
  reportWatcherError: (event: WatcherErrorEvent) => void;
  clearWatcherError: () => void;
  setOpenFileId: (fileId: string | null) => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<boolean>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<boolean>;
  createEntry: (parentId: string | null, kind: "file" | "directory") => Promise<string | null>;
  saveFile: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
  overwriteOpenFileFromSession: () => Promise<boolean>;
  retryRecover: () => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  clearError: () => void;
  reportError: (error: unknown, operation: "load" | "save" | "recover" | "settings") => void;
  clearExternalConflict: () => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
  resolveChangedConflict: (opts?: {
    force?: boolean;
  }) => Promise<"reload" | "overwrite" | "cancel">;
  resolveMissingConflict: (
    content?: string,
    opts?: { force?: boolean },
  ) => Promise<"recover" | "discard" | "cancel">;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
  initSettings: () => Promise<void>;
  updateSettings: (updated: SettingsUpdate) => Promise<boolean>;
  changeDrawingsFolder: () => Promise<boolean>;
};

type SaveGate = { action: "proceed" } | { action: "stop"; result: boolean };

export const useStore = create<State>((set, get) => {
  const gateConflictedSave = async (
    id: string,
    content: string,
    origin: SaveOrigin,
  ): Promise<SaveGate> => {
    const conflict = get().externalConflict;
    if (!conflict || conflict.fileId !== id) return { action: "proceed" };
    if (origin !== "explicit") return { action: "stop", result: false };

    if (conflict.type === "changed") {
      const choice = await get().resolveChangedConflict({ force: true });
      return choice === "overwrite" ? { action: "proceed" } : { action: "stop", result: false };
    }

    if (conflict.type === "missing") {
      const choice = await get().resolveMissingConflict(content, { force: true });
      return { action: "stop", result: choice !== "cancel" };
    }

    return { action: "proceed" };
  };

  const persistDrawingToDisk = async (
    id: string,
    content: string,
    origin: SaveOrigin,
  ): Promise<boolean> => {
    try {
      await window.api.files.write(id, content);
      const latest = get();
      set({
        error: null,
        externalConflict: null,
        dismissedConflictKey: null,
        entries: upsertSorted(latest.entries, entryAfterWrite(id, content, latest.entries)),
      });
      return true;
    } catch (error) {
      if (!isFileNotFoundMessage(cleanErrorMessage(error))) {
        set({ error: toAppError(error, "save") });
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
    dirtyById: {},
    error: null,
    filesRevision: 0,
    externalConflict: null,
    watcherDown: null,
    editorEpoch: 0,
    dismissedConflictKey: null,
    settings:
      typeof window !== "undefined"
        ? { ...DEFAULT_SETTINGS, theme: readStoredTheme(window.localStorage) }
        : DEFAULT_SETTINGS,

    loadSnapshot: (snapshot) =>
      set((state) => ({
        drawings: snapshot.info,
        entries: snapshot.entries,
        openFileId:
          state.settings.reopenLastDrawing &&
          isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
            ? snapshot.prefs.lastOpenedFileId
            : null,
        dirtyById: {},
        error: null,
        watcherDown: null,
        filesRevision: state.filesRevision,
        externalConflict: null,
        dismissedConflictKey: null,
      })),

    applyEntries: (event) => {
      const state = get();

      if (event.revision > 0 && event.revision <= state.filesRevision) return;

      set({
        ...reduceEntries(state, event),
        drawings: event.info ?? state.drawings,
        filesRevision: event.revision,
        watcherDown: null,
      });
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
        set({ openFileId: fileId, error: null, externalConflict: null });
        void window.api.store.set("lastOpenedFileId", fileId);
      } else {
        set({ error: null });
      }
    },

    renameEntry: async (id, newName) => {
      const openId = get().openFileId;
      if (isInsideSubtree(id, openId) && get().dirtyById[openId]) {
        const ok = await get().ensureCleanOrConfirm("switch");
        if (!ok) return false;
      }

      const entry = await window.api.files.rename(id, newName);
      const { entries, openFileId, dirtyById } = get();
      const next = applySubtreeRemap({ entries, openFileId, dirtyById }, id, entry.id, {
        rootEntry: entry,
      });

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        error: null,
      });
      if (next.openFileId !== openFileId) {
        void window.api.store.set("lastOpenedFileId", next.openFileId);
      }
      return true;
    },

    renameFile: (id, newName) => get().renameEntry(id, newName),
    deleteFile: (id) => get().deleteEntry(id, "trash"),

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

      const { entries } = get();
      const next = applySubtreeDelete({ entries, openFileId, dirtyById }, id);

      set({
        entries: next.entries,
        openFileId: next.openFileId,
        dirtyById: next.dirtyById,
        error: null,
      });
      if (next.openedRemoved) {
        void window.api.store.set("lastOpenedFileId", null);
      }

      return true;
    },

    createEntry: async (parentId, kind) => {
      const name = nextDefaultName(get().entries, parentId, kind);
      const entry = await window.api.files.create(parentId, name, kind);
      set((state) => ({
        entries: upsertSorted(state.entries, entry),
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
        set({ error: toAppError(new Error("Your changes couldn't be written to disk"), "save") });
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

    clearError: () => set({ error: null }),

    reportError: (error, operation) => set({ error: toAppError(error, operation) }),

    reportWatcherError: (event) => set({ watcherDown: event.message }),

    clearWatcherError: () => set({ watcherDown: null }),

    clearExternalConflict: () => set({ externalConflict: null }),

    resolveChangedConflict: async (opts) => {
      const force = opts?.force === true;
      const state = get();
      const conflict = state.externalConflict;
      if (!conflict || conflict.type !== "changed") return "cancel";

      const key = conflictKeyOf(conflict);
      if (!force && state.dismissedConflictKey === key) return "cancel";

      const fileName = fileNameOf(state.entries, conflict.fileId);
      const expectedFileId = conflict.fileId;

      return runChangedDialog(async () => {
        const choice = await window.api.dialog.fileChanged(fileName);

        const current = get().externalConflict;
        if (!current || current.type !== "changed" || current.fileId !== expectedFileId) {
          return "cancel" as const;
        }

        if (choice === "reload") {
          set({ dismissedConflictKey: null });
          get().reloadOpenFileFromDisk();
        } else if (choice === "overwrite") {
          set({ externalConflict: null, dismissedConflictKey: null });
        } else {
          set({ dismissedConflictKey: conflictKeyOf(current) });
        }

        return choice;
      });
    },

    resolveMissingConflict: async (content, opts) => {
      if (content !== undefined) pendingRecoverContent = content;

      const force = opts?.force === true;
      const state = get();
      const conflict = state.externalConflict;
      if (!conflict || conflict.type !== "missing") return "cancel";

      const key = conflictKeyOf(conflict);
      if (!force && state.dismissedConflictKey === key) return "cancel";

      const fileName = fileNameOf(state.entries, conflict.fileId);
      const expectedFileId = conflict.fileId;

      return runRecoverDialog(async () => {
        try {
          const choice = await window.api.dialog.fileRecover(fileName);

          const current = get().externalConflict;
          if (!current || current.type !== "missing" || current.fileId !== expectedFileId) {
            return "cancel" as const;
          }

          if (choice === "cancel") {
            set({ dismissedConflictKey: conflictKeyOf(current) });
            return "cancel";
          }

          if (choice === "discard") {
            set({ dismissedConflictKey: null });
            get().discardMissingOpenFile();
            return "discard";
          }

          const body =
            pendingRecoverContent ?? sessionOwner.getSession()?.getSerializedContent() ?? null;

          if (!body) {
            set({ error: toAppError(new Error("Nothing to recover"), "recover", false) });
            return "cancel";
          }

          set({ dismissedConflictKey: null });
          const ok = await performRecover(expectedFileId, body);
          return ok ? ("recover" as const) : ("cancel" as const);
        } finally {
          pendingRecoverContent = undefined;
        }
      });
    },

    retryRecover: async () => {
      const state = get();
      const conflict = state.externalConflict;
      const fileId = conflict?.type === "missing" ? conflict.fileId : (state.openFileId ?? null);
      if (!fileId) return false;

      const body =
        pendingRecoverContent ?? sessionOwner.getSession()?.getSerializedContent() ?? null;
      if (!body) {
        set({ error: toAppError(new Error("Nothing to recover"), "recover", false) });
        return false;
      }

      return performRecover(fileId, body);
    },

    reloadOpenFileFromDisk: () => {
      const { openFileId, dirtyById, editorEpoch } = get();
      if (!openFileId) {
        set({ externalConflict: null });
        return;
      }

      set({
        externalConflict: null,
        dirtyById: removeKey(dirtyById, openFileId),
        editorEpoch: editorEpoch + 1,
        error: null,
      });
    },

    discardMissingOpenFile: () => {
      const { openFileId, dirtyById } = get();
      set({
        openFileId: null,
        externalConflict: null,
        dirtyById: openFileId ? removeKey(dirtyById, openFileId) : dirtyById,
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

    changeDrawingsFolder: async () => {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;

      const previousPath = get().drawings?.path ?? null;

      let picked: DrawingInfo;
      try {
        const info = await window.api.drawings.pick();
        if (!info) return false;
        picked = info;
      } catch (error) {
        toast.add({
          title: "Couldn’t choose the drawings folder",
          description: toAppError(error, "unexpected", false).message,
          type: "error",
        });
        return false;
      }

      if (picked.path !== null && picked.path === previousPath) return true;

      set({
        drawings: picked,
        entries: [],
        openFileId: null,
        dirtyById: {},
        error: null,
        watcherDown: null,
        externalConflict: null,
        dismissedConflictKey: null,
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
