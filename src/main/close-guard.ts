import { WINDOW_CLOSE_CANCELLED, WINDOW_WILL_CLOSE } from "@shared/channels";
import type { UnsavedChoice, UnsavedReason, WindowCloseRequest } from "@shared/ipc";
import { app, BrowserWindow, dialog } from "electron";

import { log } from "./logger";

const CHECK_TIMEOUT_MS = 5000;
const FLUSH_SILENCE_TIMEOUT_MS = 2000;
const FLUSH_WRITE_TIMEOUT_MS = 10_000;

const approvedCloses = new WeakSet<BrowserWindow>();
const readyWindows = new WeakSet<BrowserWindow>();

type QuitState = "idle" | "pending";
type CloseState = {
  awaitingRenderer: boolean;
  requestId: number;
  kind: "check" | "flush" | null;
  timer: NodeJS.Timeout | null;
};

let quitState: QuitState = "idle";
let isQuitting = false;
let nextCloseRequestId = 0;
const closeStates = new WeakMap<BrowserWindow, CloseState>();

const closeStateFor = (win: BrowserWindow) => {
  const existing = closeStates.get(win);
  if (existing) return existing;

  const state: CloseState = { awaitingRenderer: false, requestId: 0, kind: null, timer: null };
  closeStates.set(win, state);
  return state;
};

const clearTimer = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
};

const clearCloseRequest = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  clearTimer(win);
  state.awaitingRenderer = false;
  state.kind = null;
};

const sendToRenderer = (win: BrowserWindow, channel: string, ...args: unknown[]) => {
  if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  win.webContents.send(channel, ...args);
};

const isCurrentCloseRequest = (win: BrowserWindow, requestId: number) => {
  const state = closeStateFor(win);
  return state.awaitingRenderer && state.requestId === requestId;
};

export const showUnsavedChangesDialog = async (
  win: BrowserWindow | null,
  reason: UnsavedReason = "quit",
): Promise<UnsavedChoice> => {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: "You have unsaved changes.",
    detail:
      reason === "switch"
        ? "Do you want to save before leaving this drawing?"
        : "Do you want to save before quitting?",
  };

  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (response === 0) return "save";
  if (response === 1) return "discard";
  return "cancel";
};

const closeWindow = (win: BrowserWindow, reason?: string) => {
  if (win.isDestroyed()) return;

  approvedCloses.add(win);
  clearCloseRequest(win);

  const wasQuit = quitState === "pending";
  quitState = "idle";

  if (reason) log.warn(`[close-guard] ${reason}`);
  win.destroy();
  if (wasQuit) {
    isQuitting = true;
    app.quit();
  }
};

const onRendererSilent = (win: BrowserWindow) => {
  if (approvedCloses.has(win)) return;
  closeWindow(win, "force-closing window: renderer did not answer the close request in time");
};

const beginCloseFlow = (win: BrowserWindow) => {
  const state = closeStateFor(win);
  if (state.awaitingRenderer) return;

  state.awaitingRenderer = true;
  state.requestId = ++nextCloseRequestId;
  state.kind = "check";
  const request: WindowCloseRequest = { requestId: state.requestId, kind: "check" };
  sendToRenderer(win, WINDOW_WILL_CLOSE, request);
  state.timer = setTimeout(() => onRendererSilent(win), CHECK_TIMEOUT_MS);
};

export const isQuittingNow = () => isQuitting;

export const isWindowReady = (win: BrowserWindow) => readyWindows.has(win);

export const markWindowReady = (win: BrowserWindow) => {
  readyWindows.add(win);
};

export const installCloseGuard = (win: BrowserWindow) => {
  win.once("closed", () => {
    readyWindows.delete(win);
    approvedCloses.delete(win);
    clearTimer(win);
    closeStates.delete(win);
  });

  const onRendererGone = () => {
    if (!closeStateFor(win).awaitingRenderer || approvedCloses.has(win)) return;
    closeWindow(win, "force-closing window: renderer crashed during the close prompt");
  };

  win.webContents.on("unresponsive", onRendererGone);
  win.webContents.on("render-process-gone", onRendererGone);

  win.on("close", (event) => {
    if (isQuitting) return;
    if (approvedCloses.has(win)) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    if (!readyWindows.has(win)) return;

    event.preventDefault();
    beginCloseFlow(win);
  });
};

export const requestQuitViaRenderer = (win: BrowserWindow) => {
  if (quitState === "pending") return;
  quitState = "pending";
  beginCloseFlow(win);
};

export const onDirtyState = (win: BrowserWindow, requestId: number, dirty: boolean) => {
  const state = closeStateFor(win);
  if (!isCurrentCloseRequest(win, requestId) || state.kind !== "check") return;

  clearTimer(win);

  if (!dirty) {
    closeWindow(win);
    return;
  }

  void (async () => {
    let choice: UnsavedChoice;
    try {
      choice = await showUnsavedChangesDialog(win, "quit");
    } catch (error) {
      log.error("[close-guard] unsaved-changes dialog failed", error);
      clearCloseRequest(win);
      if (quitState === "pending") quitState = "idle";
      sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
      return;
    }

    if (win.isDestroyed() || !isCurrentCloseRequest(win, requestId)) return;

    if (choice === "cancel") {
      clearCloseRequest(win);
      if (quitState === "pending") quitState = "idle";
      sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
      return;
    }

    if (choice === "discard") {
      closeWindow(win);
      return;
    }

    state.kind = "flush";
    const request: WindowCloseRequest = { requestId: state.requestId, kind: "flush" };
    sendToRenderer(win, WINDOW_WILL_CLOSE, request);
    state.timer = setTimeout(() => onRendererSilent(win), FLUSH_SILENCE_TIMEOUT_MS);
  })();
};

export const onFlushStarted = (win: BrowserWindow, requestId: number) => {
  const state = closeStateFor(win);
  if (!isCurrentCloseRequest(win, requestId) || state.kind !== "flush") return;

  clearTimer(win);
  state.timer = setTimeout(() => onRendererSilent(win), FLUSH_WRITE_TIMEOUT_MS);
};

export const cancelQuit = (win: BrowserWindow, requestId: number) => {
  if (!isCurrentCloseRequest(win, requestId)) return;

  clearCloseRequest(win);
  if (quitState === "pending") quitState = "idle";
  sendToRenderer(win, WINDOW_CLOSE_CANCELLED);
};

export const destroyWindow = (win: BrowserWindow, requestId: number) => {
  if (!isCurrentCloseRequest(win, requestId)) return;

  closeWindow(win);
};
