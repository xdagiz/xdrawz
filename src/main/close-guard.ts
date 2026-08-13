import { WINDOW_WILL_CLOSE } from "@shared/channels";
import { app, BrowserWindow } from "electron";

import { log } from "./logger";

const approvedCloses = new WeakSet<BrowserWindow>();
const readyWindows = new WeakSet<BrowserWindow>();

type QuitState = "idle" | "pending";
type CloseState = {
  awaitingRenderer: boolean;
  requestId: number;
};

let quitState: QuitState = "idle";
let isQuitting = false;
let nextCloseRequestId = 0;
const closeStates = new WeakMap<BrowserWindow, CloseState>();

const closeStateFor = (win: BrowserWindow): CloseState => {
  const existing = closeStates.get(win);
  if (existing) return existing;

  const state = { awaitingRenderer: false, requestId: 0 };
  closeStates.set(win, state);
  return state;
};

const clearCloseRequest = (win: BrowserWindow) => {
  closeStateFor(win).awaitingRenderer = false;
};

const isCurrentCloseRequest = (win: BrowserWindow, requestId: number) => {
  const state = closeStateFor(win);
  return state.awaitingRenderer && state.requestId === requestId;
};

const requestCloseViaRenderer = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  if (state.awaitingRenderer) return;

  state.awaitingRenderer = true;
  state.requestId = ++nextCloseRequestId;
  win.webContents.send(WINDOW_WILL_CLOSE, state.requestId);
};

export const isQuittingNow = () => isQuitting;

export const isWindowReady = (win: BrowserWindow) => readyWindows.has(win);

export const markWindowReady = (win: BrowserWindow) => {
  readyWindows.add(win);
};

const forceClose = (win: BrowserWindow): void => {
  if (win.isDestroyed()) return;

  approvedCloses.add(win);
  clearCloseRequest(win);
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
    closeStates.delete(win);
  });

  const onRendererGone = () => {
    if (!closeStateFor(win).awaitingRenderer || approvedCloses.has(win)) return;
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
    requestCloseViaRenderer(win);
  });
};

export const requestQuitViaRenderer = (win: BrowserWindow) => {
  if (quitState === "pending") return;
  quitState = "pending";
  requestCloseViaRenderer(win);
};

export const cancelQuit = (win: BrowserWindow, requestId: number) => {
  if (!isCurrentCloseRequest(win, requestId)) return;

  clearCloseRequest(win);
  if (quitState === "pending") quitState = "idle";
};

export const destroyWindow = (win: BrowserWindow, requestId: number) => {
  if (!isCurrentCloseRequest(win, requestId)) return;

  approvedCloses.add(win);
  clearCloseRequest(win);
  if (quitState === "pending") {
    quitState = "idle";
    isQuitting = true;
    win.destroy();
    app.quit();
  } else {
    win.destroy();
  }
};
