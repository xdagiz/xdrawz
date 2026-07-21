import { DRAWINGS_GET, DRAWINGS_PICK } from "@shared/channels";
import type { DrawingInfo } from "@shared/ipc";
import { BrowserWindow, ipcMain } from "electron";

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
};

export const registerIpcHandlers = (deps: Deps) => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());

  ipcMain.handle(DRAWINGS_PICK, (event) =>
    deps.pickDrawings(BrowserWindow.fromWebContents(event.sender)),
  );
};
