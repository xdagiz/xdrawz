import { EventEmitter } from "node:events";

import type { WindowCloseRequest } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { quit: mocks.quit },
  BrowserWindow: {},
  dialog: { showMessageBox: mocks.showMessageBox },
}));

vi.mock("./logger", () => ({
  log: { warn: mocks.warn, error: mocks.error },
}));

import { WINDOW_CLOSE_CANCELLED, WINDOW_WILL_CLOSE } from "@shared/channels";

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    isCrashed: (): boolean => false,
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
  let closeGuard: typeof import("./close-guard");

  beforeEach(async () => {
    vi.resetModules();
    closeGuard = await import("./close-guard");
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
    closeGuard.installCloseGuard(browserWindow);
    closeGuard.markWindowReady(browserWindow);
    return { win, browserWindow };
  };

  it("coalesces duplicate close requests and ignores stale acknowledgements", () => {
    const { win, browserWindow } = setupWindow();

    const event = closeEvent();
    win.emit("close", event);
    win.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    const firstId = sentRequestId(win, 0);
    expect(win.webContents.send).toHaveBeenCalledWith(WINDOW_WILL_CLOSE, {
      requestId: firstId,
      kind: "check",
    });

    closeGuard.cancelQuit(browserWindow, firstId + 999);
    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    closeGuard.cancelQuit(browserWindow, firstId);
    win.emit("close", closeEvent());
    const secondId = sentRequestId(win, 1);
    expect(secondId).not.toBe(firstId);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId: secondId,
      kind: "check",
    });

    closeGuard.destroyWindow(browserWindow, firstId);
    expect(win.destroyed).toBe(false);

    closeGuard.destroyWindow(browserWindow, secondId);
    expect(win.destroyed).toBe(true);
  });

  it("closes immediately when the renderer reports clean", () => {
    const { win, browserWindow } = setupWindow();

    win.emit("close", closeEvent());
    closeGuard.onDirtyState(browserWindow, sentRequestId(win, 0), false, false);

    expect(win.destroyed).toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("keeps the window open when the user cancels the unsaved-changes dialog", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    win.emit("close", closeEvent());
    closeGuard.onDirtyState(browserWindow, sentRequestId(win, 0), true, false);
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
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, {
      requestId,
      kind: "flush",
    });

    closeGuard.onFlushStarted(browserWindow, requestId);
    expect(win.destroyed).toBe(false);

    closeGuard.destroyWindow(browserWindow, requestId);
    expect(win.destroyed).toBe(true);
  });

  it("closes without flushing when the user discards changes", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    win.emit("close", closeEvent());
    closeGuard.onDirtyState(browserWindow, sentRequestId(win, 0), false, false);
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

  it("enforces the flush timeouts: short silence, longer acked envelope", async () => {
    vi.useFakeTimers();
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushTicks();

    vi.advanceTimersByTime(1999);
    expect(win.destroyed).toBe(false);

    vi.advanceTimersByTime(2);
    expect(win.destroyed).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("force-closing"));

    const ackedWin = new FakeWindow();
    const ackedBrowserWindow = ackedWin as unknown as Electron.BrowserWindow;
    closeGuard.installCloseGuard(ackedBrowserWindow);
    closeGuard.markWindowReady(ackedBrowserWindow);

    ackedWin.emit("close", closeEvent());
    const ackedId = sentRequestId(ackedWin, 0);
    closeGuard.onDirtyState(ackedBrowserWindow, ackedId, true, false);
    await flushTicks();
    closeGuard.onFlushStarted(ackedBrowserWindow, ackedId);

    vi.advanceTimersByTime(2000);
    expect(ackedWin.destroyed).toBe(false);
    vi.advanceTimersByTime(27_999);
    expect(ackedWin.destroyed).toBe(false);
    vi.advanceTimersByTime(2);
    expect(ackedWin.destroyed).toBe(true);
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

  it("does not intercept close before ready or when the renderer already crashed", () => {
    const unready = new FakeWindow();
    const unreadyBrowserWindow = unready as unknown as Electron.BrowserWindow;
    closeGuard.installCloseGuard(unreadyBrowserWindow);

    const unreadyEvent = closeEvent();
    unready.emit("close", unreadyEvent);
    expect(unreadyEvent.preventDefault).not.toHaveBeenCalled();
    expect(unready.webContents.send).not.toHaveBeenCalled();
    expect(unready.destroyed).toBe(false);

    const crashed = new FakeWindow();
    const crashedBrowserWindow = crashed as unknown as Electron.BrowserWindow;
    closeGuard.installCloseGuard(crashedBrowserWindow);
    closeGuard.markWindowReady(crashedBrowserWindow);
    crashed.webContents.isCrashed = () => true;

    const crashedEvent = closeEvent();
    crashed.emit("close", crashedEvent);
    expect(crashedEvent.preventDefault).not.toHaveBeenCalled();
    expect(crashed.destroyed).toBe(false);
  });

  it("a cancelled pending quit leaves the app running", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 2 });

    closeGuard.requestQuitViaRenderer(browserWindow);
    closeGuard.onDirtyState(browserWindow, sentRequestId(win, 0), true, false);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(closeGuard.isQuittingNow()).toBe(false);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_CLOSE_CANCELLED);

    win.emit("close", closeEvent());
    const second = sentRequestId(win, 1);
    closeGuard.destroyWindow(browserWindow, second);
    expect(win.destroyed).toBe(true);
    expect(mocks.quit).not.toHaveBeenCalled();
  });

  it("recovers when the unsaved-changes dialog fails", async () => {
    const { win, browserWindow } = setupWindow();
    mocks.showMessageBox.mockRejectedValue(new Error("dialog exploded"));

    closeGuard.requestQuitViaRenderer(browserWindow);
    win.emit("close", closeEvent());
    const requestId = sentRequestId(win, 0);
    closeGuard.onDirtyState(browserWindow, requestId, true, false);
    await flushAsync();

    expect(win.destroyed).toBe(false);
    expect(closeGuard.isQuittingNow()).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("unsaved-changes dialog failed"),
      expect.any(Error),
    );
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_CLOSE_CANCELLED);

    win.emit("close", closeEvent());
    expect(win.webContents.send).toHaveBeenCalledTimes(3);
  });

  it("resolves a pending quit by closing and quitting", async () => {
    const clean = setupWindow();
    closeGuard.requestQuitViaRenderer(clean.browserWindow);
    closeGuard.onDirtyState(clean.browserWindow, sentRequestId(clean.win, 0), false, false);

    expect(clean.win.destroyed).toBe(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(closeGuard.isQuittingNow()).toBe(true);

    mocks.quit.mockClear();

    const discard = setupWindow();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    closeGuard.requestQuitViaRenderer(discard.browserWindow);
    discard.win.emit("close", closeEvent());
    closeGuard.onDirtyState(discard.browserWindow, sentRequestId(discard.win, 0), true, false);
    await flushAsync();

    expect(discard.win.destroyed).toBe(true);
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });
});
