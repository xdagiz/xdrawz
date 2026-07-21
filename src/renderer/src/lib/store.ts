import { DrawingInfo, FileEntry } from "@shared/ipc";
import { create } from "zustand";

type State = {
  drawings: DrawingInfo | null;
  entries: FileEntry[];
  openFileId: string | null;
};

export const useStore = create<State>(() => ({
  drawings: null,
  entries: [],
  openFileId: null,
}));
