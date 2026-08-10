import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  ExternalConflict,
  FileEntry,
  FilesChangedEvent,
  SettingsUpdate,
  UnsavedReason,
} from "@shared/ipc";
import { DEFAULT_SETTINGS, FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { create } from "zustand";

import type { SceneSessionControls } from "@/lib/scene-session";
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

const fileNameOf = (entries: FileEntry[], id: string): string => {
  const entry = entries.find((e) => e.id === id);
  return entry?.name ?? id.split("/").pop() ?? id;
};

const isFileNotFoundMessage = (message: string) => {
  return message === FILE_NOT_FOUND_MESSAGE || message.includes(FILE_NOT_FOUND_MESSAGE);
};

let fileChangedDialogInflight: Promise<"reload" | "overwrite" | "cancel"> | null = null;
let fileRecoverDialogInflight: Promise<"recover" | "discard" | "cancel"> | null = null;
let fileRecoverContent: string | undefined;

type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  error: string | null;
  activeSession: SceneSessionControls | null;
  filesRevision: number;
  externalConflict: ExternalConflict;
  editorEpoch: number;
  settings: AppSettings;
  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  applyEntries: (event: FilesChangedEvent) => void;
  setOpenFileId: (fileId: string | null) => Promise<void>;
  renameFile: (id: string, newName: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  saveFile: (id: string, content: string) => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  clearExternalConflict: () => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
  resolveChangedConflict: () => Promise<"reload" | "overwrite" | "cancel">;
  resolveMissingConflict: (content?: string) => Promise<"recover" | "discard" | "cancel">;
  registerSession: (session: SceneSessionControls) => void;
  unregisterSession: (session: SceneSessionControls) => void;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
  initSettings: () => Promise<void>;
  updateSettings: (updated: SettingsUpdate) => Promise<void>;
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
  editorEpoch: 0,
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
      filesRevision: state.filesRevision,
      externalConflict: null,
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

    set({
      entries,
      openFileId: nextOpenFileId,
      drawings: event.info ?? state.drawings,
      filesRevision: event.revision,
      externalConflict,
      dirtyById: nextDirty,
    });
  },

  setOpenFileId: async (fileId) => {
    const current = get().openFileId;
    if (fileId === current) return;

    const ok = await get().ensureCleanOrConfirm("switch");
    if (!ok) return;

    if (fileId === null) {
      set({ openFileId: null, error: null, externalConflict: null });
      window.api.store.set("lastOpenedFileId", null);
    } else if (isOpenableFile(get().entries, fileId)) {
      set({ openFileId: fileId, error: null, externalConflict: null });
      window.api.store.set("lastOpenedFileId", fileId);
    } else {
      set({ error: null });
    }
  },

  renameFile: async (id, newName) => {
    if (get().openFileId === id) {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return;
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
  },

  deleteFile: async (id) => {
    if (get().openFileId === id) {
      const ok = await get().ensureCleanOrConfirm("switch");
      if (!ok) return;
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
  },

  saveFile: async (id, content) => {
    if (!id) return false;

    const state = get();
    const conflict = state.externalConflict;

    if (conflict?.type === "changed" && conflict.fileId === id) {
      const choice = await get().resolveChangedConflict();
      if (choice !== "overwrite") return false;
    }

    if (conflict?.type === "missing" && conflict.fileId === id) {
      const choice = await get().resolveMissingConflict(content);
      return choice !== "cancel";
    }

    try {
      await window.api.files.write(id, content);
      set({ error: null, externalConflict: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save";

      if (isFileNotFoundMessage(message)) {
        const latest = get();
        if (latest.externalConflict?.type !== "missing" || latest.externalConflict.fileId !== id) {
          set({ externalConflict: { type: "missing", fileId: id } });
        }

        const choice = await get().resolveMissingConflict(content);
        return choice !== "cancel";
      }

      set({ error: message });
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

  clearExternalConflict: () => set({ externalConflict: null }),

  resolveChangedConflict: async () => {
    if (!fileChangedDialogInflight) {
      const state = get();
      const conflict = state.externalConflict;
      if (!conflict || conflict.type !== "changed") return "cancel";

      const fileName = fileNameOf(state.entries, conflict.fileId);
      const expectedFileId = conflict.fileId;

      fileChangedDialogInflight = (async () => {
        const choice = await window.api.dialog.fileChanged(fileName);

        const current = get().externalConflict;
        if (!current || current.type !== "changed" || current.fileId !== expectedFileId) {
          return "cancel" as const;
        }

        if (choice === "reload") get().reloadOpenFileFromDisk();
        else if (choice === "overwrite") set({ externalConflict: null });

        return choice;
      })().finally(() => {
        fileChangedDialogInflight = null;
      });
    }

    return fileChangedDialogInflight;
  },

  resolveMissingConflict: async (content) => {
    if (content !== undefined) fileRecoverContent = content;

    if (!fileRecoverDialogInflight) {
      const state = get();
      const conflict = state.externalConflict;
      const fileId = conflict?.type === "missing" ? conflict.fileId : (state.openFileId ?? null);
      if (!fileId) return "cancel";

      const fileName = fileNameOf(state.entries, fileId);
      const expectedFileId = fileId;

      fileRecoverDialogInflight = (async () => {
        const choice = await window.api.dialog.fileRecover(fileName);

        const current = get().externalConflict;
        if (current && (current.type !== "missing" || current.fileId !== expectedFileId)) {
          return "cancel" as const;
        }

        if (choice === "cancel") return "cancel";

        if (choice === "discard") {
          get().discardMissingOpenFile();
          return "discard";
        }

        const body = fileRecoverContent ?? get().activeSession?.getSerializedContent() ?? null;
        fileRecoverContent = undefined;

        if (!body) {
          set({ error: "Nothing to recover" });
          return "cancel";
        }

        try {
          await window.api.files.writeRecover(expectedFileId, body);
          const entries = await window.api.files.list();
          set({
            error: null,
            externalConflict: null,
            entries,
            dirtyById: removeKey(get().dirtyById, expectedFileId),
          });
          return "recover" as const;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Recovery failed";
          set({ error: errMsg });
          return "cancel";
        }
      })().finally(() => {
        fileRecoverDialogInflight = null;
        fileRecoverContent = undefined;
      });
    }

    return fileRecoverDialogInflight;
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
    window.api.store.set("lastOpenedFileId", null);
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
    }
  },

  updateSettings: async (updated) => {
    try {
      const settings = await window.api.settings.update(updated);
      writeStoredTheme(window.localStorage, settings.theme);
      set({ settings });
    } catch (error) {
      console.error("failed to update settings:", error);
    }
  },
}));
