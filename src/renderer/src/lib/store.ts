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
import { DEFAULT_SETTINGS, FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { create } from "zustand";

import { toast } from "@/components/ui/toast";
import { toAppError, type AppError } from "@/lib/app-error";
import type { DrawingSessionControls } from "@/lib/drawing-session";
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

const fileNameOf = (entries: FileEntry[], id: string) => {
  const entry = entries.find((e) => e.id === id);
  return entry?.name ?? id.split("/").pop() ?? id;
};

const isFileNotFoundMessage = (message: string) => {
  return message === FILE_NOT_FOUND_MESSAGE || message.includes(FILE_NOT_FOUND_MESSAGE);
};

const parentIdOf = (id: string) => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
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

export type SaveOrigin = "auto" | "explicit";

let fileChangedDialogInflight: Promise<"reload" | "overwrite" | "cancel"> | null = null;
let fileRecoverDialogInflight: Promise<"recover" | "discard" | "cancel"> | null = null;
let fileRecoverContent: string | undefined;

const conflictKeyOf = (conflict: NonNullable<ExternalConflict>) =>
  conflict.type === "changed"
    ? `changed:${conflict.fileId}:${conflict.diskModifiedAt}`
    : `missing:${conflict.fileId}`;

const entryAfterWrite = (id: string, content: string, entries: FileEntry[]): FileEntry => {
  const existing = entries.find((e) => e.id === id);
  const now = Date.now();
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const size = new TextEncoder().encode(normalized).byteLength;
  if (existing) {
    return {
      ...existing,
      modifiedAt: Math.max(existing.modifiedAt + 1, now),
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
  activeSession: DrawingSessionControls | null;
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
  renameFile: (id: string, newName: string) => Promise<boolean>;
  deleteFile: (id: string) => Promise<boolean>;
  saveFile: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>;
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
  registerSession: (session: DrawingSessionControls) => void;
  unregisterSession: (session: DrawingSessionControls) => void;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
  initSettings: () => Promise<void>;
  updateSettings: (updated: SettingsUpdate) => Promise<boolean>;
};

export const useStore = create<State>((set, get) => ({
  drawings: null,
  entries: [],
  openFileId: null,
  dirtyById: {},
  error: null,
  activeSession: null,
  filesRevision: 0,
  externalConflict: null,
  watcherDown: null,
  editorEpoch: 0,
  dismissedConflictKey: null,
  settings:
    typeof window !== "undefined"
      ? { theme: readStoredTheme(window.localStorage) }
      : DEFAULT_SETTINGS,

  loadSnapshot: (snapshot) =>
    set((state) => ({
      drawings: snapshot.info,
      entries: snapshot.entries,
      openFileId: isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
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

    const entries = event.entries;
    const openFileId = state.openFileId;
    const dirtyById = state.dirtyById;
    const prevConflict = state.externalConflict;

    let externalConflict: ExternalConflict = null;
    let nextOpenFileId = openFileId;
    let nextEditorEpoch = state.editorEpoch;

    if (openFileId) {
      const stillExists = entries.some((e) => e.id === openFileId && e.kind === "file");

      if (!stillExists && dirtyById[openFileId]) {
        externalConflict = { type: "missing", fileId: openFileId };
      } else if (stillExists && dirtyById[openFileId]) {
        const oldEntry = state.entries.find((e) => e.id === openFileId);
        const newEntry = entries.find((e) => e.id === openFileId);

        if (
          prevConflict?.type === "changed" &&
          prevConflict.fileId === openFileId &&
          newEntry &&
          newEntry.modifiedAt >= prevConflict.diskModifiedAt
        ) {
          externalConflict = {
            type: "changed",
            fileId: openFileId,
            diskModifiedAt: Math.max(prevConflict.diskModifiedAt, newEntry.modifiedAt),
          };
        } else if (oldEntry && newEntry && newEntry.modifiedAt > oldEntry.modifiedAt) {
          externalConflict = {
            type: "changed",
            fileId: openFileId,
            diskModifiedAt: newEntry.modifiedAt,
          };
        } else if (
          prevConflict?.type === "missing" &&
          prevConflict.fileId === openFileId &&
          newEntry
        ) {
          externalConflict = {
            type: "changed",
            fileId: openFileId,
            diskModifiedAt: newEntry.modifiedAt,
          };
        }
      } else if (stillExists && !dirtyById[openFileId]) {
        const oldEntry = state.entries.find((e) => e.id === openFileId);
        const newEntry = entries.find((e) => e.id === openFileId);
        if (oldEntry && newEntry && newEntry.modifiedAt > oldEntry.modifiedAt) {
          nextEditorEpoch = state.editorEpoch + 1;
        }
      }

      if (!stillExists && !dirtyById[openFileId]) {
        nextOpenFileId = null;
      }
    }

    const nextDirty = { ...dirtyById };
    for (const id of Object.keys(nextDirty)) {
      if (id === openFileId && externalConflict?.type === "missing") continue;
      if (!entries.some((e) => e.id === id)) delete nextDirty[id];
    }

    const nextKey = externalConflict ? conflictKeyOf(externalConflict) : null;
    const dismissedConflictKey =
      nextKey && state.dismissedConflictKey === nextKey ? state.dismissedConflictKey : null;

    set({
      entries,
      openFileId: nextOpenFileId,
      drawings: event.info ?? state.drawings,
      filesRevision: event.revision,
      externalConflict,
      dirtyById: nextDirty,
      watcherDown: null,
      editorEpoch: nextEditorEpoch,
      dismissedConflictKey,
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

  renameFile: async (id, newName) => {
    if (get().openFileId === id) {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;
    }

    const entry = await window.api.files.rename(id, newName);
    const { openFileId, dirtyById } = get();
    const entries = await window.api.files.list();

    const nextDirty = { ...dirtyById };
    if (id !== entry.id && nextDirty[id]) {
      delete nextDirty[id];
      nextDirty[entry.id] = true;
    }

    set({
      entries,
      openFileId: openFileId === id ? entry.id : openFileId,
      dirtyById: nextDirty,
      error: null,
    });
    return true;
  },

  deleteFile: async (id) => {
    if (get().openFileId === id) {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return false;
    }

    await window.api.files.delete(id);
    const { openFileId, dirtyById } = get();
    const entries = await window.api.files.list();

    const nextDirty = { ...dirtyById };
    delete nextDirty[id];

    set({
      entries,
      openFileId: openFileId === id ? null : openFileId,
      dirtyById: nextDirty,
      error: null,
    });

    return true;
  },

  saveFile: async (id, content, origin = "auto") => {
    if (!id) return false;

    const state = get();
    const conflict = state.externalConflict;

    if (conflict?.type === "changed" && conflict.fileId === id) {
      if (origin !== "explicit") return false;
      const choice = await get().resolveChangedConflict({ force: true });
      if (choice !== "overwrite") return false;
    }

    if (conflict?.type === "missing" && conflict.fileId === id) {
      if (origin !== "explicit") return false;
      const choice = await get().resolveMissingConflict(content, { force: true });
      return choice !== "cancel";
    }

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
      const message = cleanErrorMessage(error);

      if (isFileNotFoundMessage(message)) {
        const latest = get();
        if (latest.externalConflict?.type !== "missing" || latest.externalConflict.fileId !== id) {
          set({ externalConflict: { type: "missing", fileId: id } });
        }

        if (origin !== "explicit") return false;

        const choice = await get().resolveMissingConflict(content, { force: true });
        return choice !== "cancel";
      }

      set({ error: toAppError(error, "save") });
      return false;
    }
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

    if (!fileChangedDialogInflight) {
      const fileName = fileNameOf(state.entries, conflict.fileId);
      const expectedFileId = conflict.fileId;

      fileChangedDialogInflight = (async () => {
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
      })().finally(() => {
        fileChangedDialogInflight = null;
      });
    }

    return fileChangedDialogInflight;
  },

  resolveMissingConflict: async (content, opts) => {
    if (content !== undefined) fileRecoverContent = content;

    const force = opts?.force === true;
    const state = get();
    const conflict = state.externalConflict;
    if (!conflict || conflict.type !== "missing") return "cancel";

    const key = conflictKeyOf(conflict);
    if (!force && state.dismissedConflictKey === key) return "cancel";

    const fileId = conflict.fileId;

    if (!fileRecoverDialogInflight) {
      const fileName = fileNameOf(state.entries, fileId);
      const expectedFileId = fileId;

      fileRecoverDialogInflight = (async () => {
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

        const body = fileRecoverContent ?? get().activeSession?.getSerializedContent() ?? null;
        fileRecoverContent = undefined;

        if (!body) {
          set({ error: toAppError(new Error("Nothing to recover"), "recover", false) });
          return "cancel";
        }

        set({ dismissedConflictKey: null });
        const ok = await performRecover(expectedFileId, body);
        return ok ? ("recover" as const) : ("cancel" as const);
      })().finally(() => {
        fileRecoverDialogInflight = null;
        fileRecoverContent = undefined;
      });
    }

    return fileRecoverDialogInflight;
  },

  retryRecover: async () => {
    const state = get();
    const conflict = state.externalConflict;
    const fileId = conflict?.type === "missing" ? conflict.fileId : (state.openFileId ?? null);
    if (!fileId) return false;

    const body = fileRecoverContent ?? state.activeSession?.getSerializedContent() ?? null;
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

  registerSession: (session) => set({ activeSession: session }),

  unregisterSession: (session) => {
    set((state) => (state.activeSession === session ? { activeSession: null } : state));
  },

  ensureCleanOrConfirm: async (reason = "switch") => {
    const session = get().activeSession;
    if (!session) {
      return Object.keys(get().dirtyById).length === 0;
    }

    return session.ensureCleanOrConfirm(reason, window.api.dialog.unsavedChanges);
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
}));
