import {
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_LIST,
  FILES_READ,
} from "@shared/channels";
import type { DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { BrowserWindow, ipcMain } from "electron";

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: () => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
  readSceneFile: (id: string) => Promise<string>;
};

export const registerIpcHandlers = (deps: Deps) => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());
  ipcMain.handle(DRAWINGS_LOAD, () => deps.loadDrawings());
  ipcMain.handle(FILES_LIST, () => deps.listEntries());
  ipcMain.handle(FILES_READ, (_event, id: string) => deps.readSceneFile(id));

  ipcMain.handle(DRAWINGS_PICK, (event) =>
    deps.pickDrawings(BrowserWindow.fromWebContents(event.sender)),
  );
};
