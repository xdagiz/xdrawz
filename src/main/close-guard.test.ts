import { EventEmitter } from "node:events";

import type { WindowCloseRequest } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { quit: mocks.quit },
  BrowserWindow: class {},
  dialog: { showMessageBox: mocks.showMessageBox },
}));

vi.mock("./logger", () => ({
  log: { warn: mocks.warn, error: mocks.error },
}));

import { WINDOW_CLOSE_CANCELLED, WINDOW_WILL_CLOSE } from "@shared/channels";

import {
  cancelQuit,
  destroyWindow,
  installCloseGuard,
  isQuittingNow,
  markWindowReady,
  onDirtyState,
  onFlushStarted,
  requestQuitViaRenderer,
  showUnsavedChangesDialog,
} from "./close-guard";

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    isCrashed: () => false as boolean,
    send: vi.fn(),
  });

  isDestroyed = () => this.destroyed;

  destroy = () => {
    this.destroyed = true;
    this.emit("closed");
  };
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const flushTicks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const closeEvent = () => ({ preventDefault: vi.fn() });

const sentRequestId = (win: FakeWindow, callIndex: number): number => {
  const willCloseCalls = win.webContents.send.mock.calls.filter(
    ([channel]) => channel === WINDOW_WILL_CLOSE,
  ) as [string, WindowCloseRequest][];
  const payload = willCloseCalls[callIndex][1];
  return payload.requestId;
};

describe("close guard", () => {
  beforeEach(() => {
    mocks.quit.mockReset();
    mocks.warn.mockReset();
    mocks.error.mockReset();
    mocks.showMessageBox.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setupWindow = () => {
    const win = new FakeWindow();
    const browserWindow = win as unknown as Electron.BrowserWindow;
    installCloseGuard(browserWindow);
    markWindowReady(browserWindow);
    return { win, browserWindow };
  };

  it("coalesces duplicate close requests and ignores stale acknowledgements", () => {
    const { win, browserWindow } = setupWindow();

    const event = closeEvent();
    win.emit("close", event);
    win.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(WINDOW_WILL_CLOSE, {
      requestId: 1,
      kind: "check",
    });

    cancelQuit(browserWindow, 2);
    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    cancelQuit(browserWindow, 1);
    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId: 2,
      kind: "check",
    });

    destroyWindow(browserWindow, 1);
    expect(win.destroyed).toBe(false);

    destroyWindow(browserWindow, 2);
    expect(win.destroyed).toBe(true);
  });

  it("closes immediately when the renderer reports clean", () => {
    const { win, browserWindow } = setupWindow();

    win.emit("close", closeEvent());
    onDirtyState(browserWindow, sentRequestId(win, 0), false);

    expect(win.destroyed).toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("keeps the window open when the user cancels the unsaved-changes dialog", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    win.emit("close", closeEvent());
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_CLOSE_CANCELLED);

    win.emit("close", closeEvent());
    const second = sentRequestId(win, 1);
    expect(second).not.toBe(sentRequestId(win, 0));
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId: second,
      kind: "check",
    });
  });

  it("shows the dialog when dirty, then flushes and closes once the renderer finishes", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    onDirtyState(browserWindow, requestId, true);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId,
      kind: "flush",
    });

    onFlushStarted(browserWindow, requestId);
    expect(win.destroyed).toBe(false);

    destroyWindow(browserWindow, requestId);
    expect(win.destroyed).toBe(true);
  });

  it("closes without flushing when the user discards changes", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    win.emit("close", closeEvent());
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  it("force-closes when the renderer never answers the check", () => {
    vi.useFakeTimers();
    const { win } = setupWindow();

    win.emit("close", closeEvent());
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(4999);
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(2);
    expect(win.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("force-closing"));
  });

  it("does not stack a second check while the dialog is open", async () => {
    const { win, browserWindow } = setupWindow();
    let resolveDialog!: (value: { response: number }) => void;
    mocks.showMessageBox.mockImplementation(
      () => new Promise<{ response: number }>((resolve) => (resolveDialog = resolve)),
    );

    win.emit("close", closeEvent());
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushTicks();

    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    resolveDialog({ response: 2 });
    await flushTicks();
    expect(win.destroyed).toBe(false);

    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
    expect(win.webContents.send.mock.calls[1]).toEqual([WINDOW_CLOSE_CANCELLED]);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId: expect.any(Number),
      kind: "check",
    });
  });

  it("ignores stale dirty replies after the flow was cancelled", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    win.emit("close", closeEvent());
    const first = sentRequestId(win, 0);
    onDirtyState(browserWindow, first, true);
    await flushAsync();

    onDirtyState(browserWindow, first, false);
    expect(win.destroyed).toBe(false);

    win.emit("close", closeEvent());
    const second = sentRequestId(win, 1);
    expect(second).not.toBe(first);
    onDirtyState(browserWindow, second, false);
    expect(win.destroyed).toBe(true);
  });

  it("force-closes when the renderer never acks the flush", async () => {
    vi.useFakeTimers();
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    onDirtyState(browserWindow, requestId, true);
    await flushTicks();

    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId,
      kind: "flush",
    });

    vi.advanceTimersByTime(1999);
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(2);
    expect(win.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("force-closing"));
  });

  it("gives an acked flush a generous write envelope", async () => {
    vi.useFakeTimers();
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    onDirtyState(browserWindow, requestId, true);
    await flushTicks();
    onFlushStarted(browserWindow, requestId);

    // The ack must replace the 2s silence timer, not stack on top of it.
    vi.advanceTimersByTime(2000);
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(7999);
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(2);
    expect(win.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("force-closing"));
  });

  it("ignores flush acks for a stale request", async () => {
    vi.useFakeTimers();
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    onDirtyState(browserWindow, requestId, true);
    await flushTicks();

    onFlushStarted(browserWindow, requestId + 1);

    vi.advanceTimersByTime(2001);
    expect(win.destroyed).toBe(true);
  });

  it("force-closes when the renderer crashes or hangs during the close prompt", () => {
    const { win } = setupWindow();
    win.emit("close", closeEvent());
    win.webContents.emit("render-process-gone");
    expect(win.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("crashed"));

    const { win: hungWin } = setupWindow();
    hungWin.emit("close", closeEvent());
    hungWin.webContents.emit("unresponsive");
    expect(hungWin.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenLastCalledWith(expect.stringContaining("force-closing"));
  });

  it("leaves a crashed renderer alone outside a close flow", () => {
    const { win } = setupWindow();
    win.webContents.emit("render-process-gone");
    expect(win.destroyed).toBe(false);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not intercept close before the renderer marks itself ready", () => {
    const win = new FakeWindow();
    const browserWindow = win as unknown as Electron.BrowserWindow;
    installCloseGuard(browserWindow);

    const event = closeEvent();
    win.emit("close", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
  });

  it("does not intercept close when the renderer is already crashed", () => {
    const win = new FakeWindow();
    const browserWindow = win as unknown as Electron.BrowserWindow;
    installCloseGuard(browserWindow);
    markWindowReady(browserWindow);
    win.webContents.isCrashed = () => true;

    const event = closeEvent();
    win.emit("close", event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
  });

  it("a cancelled pending quit leaves the app running", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    requestQuitViaRenderer(browserWindow);
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(isQuittingNow()).toBe(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_CLOSE_CANCELLED);

    win.emit("close", closeEvent());
    const second = sentRequestId(win, 1);
    destroyWindow(browserWindow, second);
    expect(win.destroyed).toBe(true);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("recovers when the unsaved-changes dialog fails", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockRejectedValue(new Error("dialog exploded"));

    win.emit("close", closeEvent());
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("unsaved-changes dialog failed"),
      expect.any(Error),
    );

    // The failed dialog must still resume the renderer's paused autosave.
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_CLOSE_CANCELLED);

    // The failed dialog must not swallow later close attempts.
    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });

  it("resets a pending quit when the dialog fails", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockRejectedValue(new Error("dialog exploded"));

    requestQuitViaRenderer(browserWindow);
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(isQuittingNow()).toBe(false);

    // The quit state was reset: a fresh close attempt starts a new flow.
    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });
  it("quits the app when a pending quit resolves clean", () => {
    const { win, browserWindow } = setupWindow();

    requestQuitViaRenderer(browserWindow);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(isQuittingNow()).toBe(false);

    onDirtyState(browserWindow, sentRequestId(win, 0), false);

    expect(win.destroyed).toBe(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(isQuittingNow()).toBe(true);
  });

  it("discarding during a pending quit still quits the app", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    requestQuitViaRenderer(browserWindow);
    onDirtyState(browserWindow, sentRequestId(win, 0), true);
    await flushAsync();

    expect(win.destroyed).toBe(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });

  it("maps unsaved-changes dialog responses and reason-specific text", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await showUnsavedChangesDialog(null, "switch")).toBe("save");
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "warning",
        buttons: ["Save", "Don't save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        detail: expect.stringContaining("leaving this drawing"),
      }),
    );

    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await showUnsavedChangesDialog(null)).toBe("discard");

    mocks.showMessageBox.mockResolvedValue({ response: 2 });
    expect(await showUnsavedChangesDialog(null, "quit")).toBe("cancel");
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("quitting") }),
    );
  });

  it("attaches the unsaved-changes dialog to the window when one is available", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });
    await showUnsavedChangesDialog(browserWindow, "switch");
    expect(mocks.showMessageBox).toHaveBeenCalledWith(win, expect.any(Object));
  });
});
