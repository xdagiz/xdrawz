import type { DrawingInfo, DrawingsSnapshot, FileEntry, UnsavedReason } from "@shared/ipc";
import { create } from "zustand";

import type { SceneSessionControls } from "@/lib/scene-session";

const isOpenableFile = (
  entries: FileEntry[],
  fileId: string | null | undefined,
): fileId is string =>
  typeof fileId === "string" &&
  fileId.length > 0 &&
  entries.some((entry) => entry.id === fileId && entry.kind === "file");

type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  error: string | null;
  activeSession: SceneSessionControls | null;

  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  setOpenFileId: (fileId: string | null) => Promise<void>;
  renameFile: (id: string, newName: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  saveFile: (id: string, content: string) => Promise<boolean>;
  setFileDirty: (id: string, dirty: boolean) => void;
  registerSession: (session: SceneSessionControls) => void;
  unregisterSession: (session: SceneSessionControls) => void;
  ensureCleanOrConfirm: (reason?: UnsavedReason) => Promise<boolean>;
};

export const useStore = create<State>((set, get) => ({
  drawings: null,
  entries: [],
  openFileId: null,
  dirtyById: {},
  error: null,
  activeSession: null,

  loadSnapshot: (snapshot) =>
    set({
      drawings: snapshot.info,
      entries: snapshot.entries,
      openFileId: isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
        ? snapshot.prefs.lastOpenedFileId
        : null,
      dirtyById: {},
      error: null,
    }),

  setOpenFileId: async (fileId) => {
    const current = get().openFileId;
    if (fileId === current) return;

    const ok = await get().ensureCleanOrConfirm("switch");
    if (!ok) return;

    if (fileId === null) {
      set({ openFileId: null, error: null });
      return;
    }

    set((state) => ({
      openFileId: isOpenableFile(state.entries, fileId) ? fileId : state.openFileId,
      error: null,
    }));
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
    try {
      await window.api.files.write(id, content);
      set({ error: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save";
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
}));
