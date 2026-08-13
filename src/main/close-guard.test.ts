import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { quit: mocks.quit },
  BrowserWindow: class {},
}));

vi.mock("./logger", () => ({
  log: { warn: mocks.warn },
}));

import { WINDOW_WILL_CLOSE } from "@shared/channels";

import { cancelQuit, destroyWindow, installCloseGuard, markWindowReady } from "./close-guard";

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    isCrashed: () => false,
    send: vi.fn(),
  });

  isDestroyed = () => this.destroyed;

  destroy = () => {
    this.destroyed = true;
    this.emit("closed");
  };
}

describe("close guard", () => {
  it("coalesces duplicate close requests and ignores stale acknowledgements", () => {
    const win = new FakeWindow();
    const browserWindow = win as unknown as Electron.BrowserWindow;
    installCloseGuard(browserWindow);
    markWindowReady(browserWindow);

    const closeEvent = { preventDefault: vi.fn() };
    win.emit("close", closeEvent);
    win.emit("close", closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(WINDOW_WILL_CLOSE, 1);

    cancelQuit(browserWindow, 2);
    win.emit("close", closeEvent);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    cancelQuit(browserWindow, 1);
    win.emit("close", closeEvent);
    expect(win.webContents.send).toHaveBeenLastCalledWith(WINDOW_WILL_CLOSE, 2);

    destroyWindow(browserWindow, 1);
    expect(win.destroyed).toBe(false);

    destroyWindow(browserWindow, 2);
    expect(win.destroyed).toBe(true);
  });
});
