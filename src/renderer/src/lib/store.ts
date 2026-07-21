import { DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
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
};

export const useStore = create<State>((set) => ({
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
}));
