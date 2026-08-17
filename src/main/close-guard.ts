import { WINDOW_WILL_CLOSE } from "@shared/channels";
import { app, BrowserWindow } from "electron";

import { log } from "./logger";

const approvedCloses = new WeakSet<BrowserWindow>();
const readyWindows = new WeakSet<BrowserWindow>();

type QuitState = "idle" | "pending";
let quitState: QuitState = "idle";
let isQuitting = false;
let awaitingCloseAck = false;

export const isQuittingNow = () => isQuitting;

export const isWindowReady = (win: BrowserWindow) => readyWindows.has(win);

export const markWindowReady = (win: BrowserWindow) => {
  readyWindows.add(win);
};

const forceClose = (win: BrowserWindow): void => {
  if (win.isDestroyed()) return;
  approvedCloses.add(win);
  awaitingCloseAck = false;
  const wasQuit = quitState === "pending";
  quitState = "idle";
  log.warn("[close-guard] force-closing window: renderer unresponsive/crashed during close prompt");
  win.destroy();
  if (wasQuit) {
    isQuitting = true;
    app.quit();
  }
};

export const installCloseGuard = (win: BrowserWindow) => {
  win.once("closed", () => {
    readyWindows.delete(win);
    approvedCloses.delete(win);
  });

  const onRendererGone = () => {
    if (!awaitingCloseAck || approvedCloses.has(win)) return;
    forceClose(win);
  };

  win.webContents.on("unresponsive", onRendererGone);
  win.webContents.on("render-process-gone", onRendererGone);

  win.on("close", (event) => {
    if (isQuitting) return;
    if (approvedCloses.has(win)) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    if (!readyWindows.has(win)) return;

    event.preventDefault();
    awaitingCloseAck = true;
    win.webContents.send(WINDOW_WILL_CLOSE);
  });
};

export const requestQuitViaRenderer = (win: BrowserWindow) => {
  if (quitState === "pending") return;
  quitState = "pending";
  awaitingCloseAck = true;
  win.webContents.send(WINDOW_WILL_CLOSE);
};

export const cancelQuit = (): void => {
  if (quitState !== "pending") return;
  quitState = "idle";
  awaitingCloseAck = false;
};

export const destroyWindow = (win: BrowserWindow) => {
  approvedCloses.add(win);
  awaitingCloseAck = false;
  if (quitState === "pending") {
    quitState = "idle";
    isQuitting = true;
    win.destroy();
    app.quit();
  } else {
    win.destroy();
  }
};
