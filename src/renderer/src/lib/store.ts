import type { DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { create } from "zustand";

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
  loadSnapshot: (snapshot: DrawingsSnapshot) => void;
  setOpenFileId: (fileId: string | null) => void;
  renameFile: (id: string, newName: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
};

export const useStore = create<State>((set, get) => ({
  drawings: null,
  entries: [],
  openFileId: null,

  loadSnapshot: (snapshot) =>
    set({
      drawings: snapshot.info,
      entries: snapshot.entries,
      openFileId: isOpenableFile(snapshot.entries, snapshot.prefs.lastOpenedFileId)
        ? snapshot.prefs.lastOpenedFileId
        : null,
    }),

  setOpenFileId: (fileId) =>
    set((state) => {
      if (fileId === null) {
        return { openFileId: null };
      }

      return {
        openFileId: isOpenableFile(state.entries, fileId) ? fileId : state.openFileId,
      };
    }),

  renameFile: async (id, newName) => {
    const entry = await window.api.files.rename(id, newName);
    const { openFileId } = get();
    const entries = await window.api.files.list();
    set({
      entries,
      openFileId: openFileId === id ? entry.id : openFileId,
    });
  },

  deleteFile: async (id) => {
    await window.api.files.delete(id);
    const { openFileId } = get();
    const entries = await window.api.files.list();
    set({
      entries,
      openFileId: openFileId === id ? null : openFileId,
    });
  },
}));
