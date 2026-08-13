import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
}));

// Force the context-isolated branch so the api object is handed to
// contextBridge instead of the (absent) window global.
Object.defineProperty(process, "contextIsolated", { value: true, configurable: true });

import { WINDOW_CANCEL_QUIT, WINDOW_CLOSE, WINDOW_WILL_CLOSE } from "@shared/channels";

import type { NativeApi } from "./types";

describe("preload window api", () => {
  let api: NativeApi;

  beforeAll(async () => {
    await import("./index");
    api = mocks.expose.mock.calls[0]?.[1] as NativeApi;
    expect(api).toBeDefined();
  });

  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.send.mockReset();
    mocks.on.mockReset();
    mocks.removeListener.mockReset();
  });

  it("forwards the will-close request id to the callback", () => {
    const cb = vi.fn();
    const unsubscribe = api.window.onWillClose(cb);

    const registration = mocks.on.mock.calls.find(([channel]) => channel === WINDOW_WILL_CLOSE);
    expect(registration).toBeDefined();
    const [, listener] = registration as [string, (event: unknown, requestId: number) => void];

    listener({} as Electron.IpcRendererEvent, 7);
    expect(cb).toHaveBeenCalledWith(7);

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(WINDOW_WILL_CLOSE, listener);
  });

  it("passes the request id back on close", () => {
    api.window.close(3);
    expect(mocks.invoke).toHaveBeenCalledWith(WINDOW_CLOSE, 3);
  });

  it("passes the request id back on cancelQuit", () => {
    api.window.cancelQuit?.(4);
    expect(mocks.send).toHaveBeenCalledWith(WINDOW_CANCEL_QUIT, 4);
  });
});
