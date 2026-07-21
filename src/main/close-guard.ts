import { WINDOW_WILL_CLOSE } from "@shared/channels";
import { BrowserWindow } from "electron";

const approvedCloses = new WeakSet<BrowserWindow>();

export const installCloseGuard = (win: BrowserWindow): void => {
  win.on("close", (event) => {
    if (approvedCloses.has(win)) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;

    event.preventDefault();
    win.webContents.send(WINDOW_WILL_CLOSE);
  });
};

export const destroyWindow = (win: BrowserWindow): void => {
  approvedCloses.add(win);
  if (!win.isDestroyed()) win.destroy();
};
