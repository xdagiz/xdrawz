import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

import {
  FILES_READ,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_CLOSE_CANCELLED,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_WILL_CLOSE,
} from "@shared/channels";

import type { NativeApi } from "./types";

describe("preload window api", () => {
  let api: NativeApi;

  beforeAll(async () => {
    await import("./index");
    api = mocks.expose.mock.calls[0]?.[1] as NativeApi;
    expect(api).toBeDefined();
  });

  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.send.mockReset();
    mocks.on.mockReset();
    mocks.removeListener.mockReset();
  });

  it("forwards the will-close request to the callback", () => {
    const cb = vi.fn();
    const unsubscribe = api.window.onWillClose(cb);

    const registration = mocks.on.mock.calls.find(([channel]) => channel === WINDOW_WILL_CLOSE);
    expect(registration).toBeDefined();
    const [, listener] = registration as [
      string,
      (event: unknown, request: { requestId: number; kind: "check" | "flush" }) => void,
    ];

    listener({}, { requestId: 7, kind: "check" });
    expect(cb).toHaveBeenCalledWith({ requestId: 7, kind: "check" });

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(WINDOW_WILL_CLOSE, listener);
  });

  it("forwards the close-cancelled signal to the callback", () => {
    const cb = vi.fn();
    const unsubscribe = api.window.onCloseCancelled(cb);

    const registration = mocks.on.mock.calls.find(
      ([channel]) => channel === WINDOW_CLOSE_CANCELLED,
    );
    expect(registration).toBeDefined();
    const [, listener] = registration as [string, (event: unknown) => void];

    listener({});
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(WINDOW_CLOSE_CANCELLED, listener);
  });

  it("passes the request id back on close", () => {
    void api.window.close(3);
    expect(mocks.invoke).toHaveBeenCalledWith(WINDOW_CLOSE, 3);
  });

  it("passes rejections through without preprocessing", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("boom"));

    await expect(api.files.read("big.excalidraw")).rejects.toThrow("boom");
    expect(mocks.invoke).toHaveBeenCalledWith(FILES_READ, "big.excalidraw");
  });

  it("passes the request id back on cancelQuit", () => {
    api.window.cancelQuit(4);
    expect(mocks.send).toHaveBeenCalledWith(WINDOW_CANCEL_QUIT, 4);
  });

  it("reports the dirty state on the dirty-state channel", () => {
    api.window.reportDirtyState(7, true);
    expect(mocks.send).toHaveBeenCalledWith(WINDOW_DIRTY_STATE, 7, true);
  });

  it("reports flush start on the flush-started channel", () => {
    api.window.flushStarted(9);
    expect(mocks.send).toHaveBeenCalledWith(WINDOW_FLUSH_STARTED, 9);
  });
});
