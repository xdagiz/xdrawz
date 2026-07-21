import { DRAWINGS_GET, DRAWINGS_LOAD, DRAWINGS_PICK, FILES_LIST } from "@shared/channels";
import type { DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { BrowserWindow, ipcMain } from "electron";

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: () => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
};

export const registerIpcHandlers = (deps: Deps) => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());
  ipcMain.handle(DRAWINGS_LOAD, () => deps.loadDrawings());
  ipcMain.handle(FILES_LIST, () => deps.listEntries());

  ipcMain.handle(DRAWINGS_PICK, (event) =>
    deps.pickDrawings(BrowserWindow.fromWebContents(event.sender)),
  );
};
