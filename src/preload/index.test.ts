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

import { FILES_READ, FILES_WRITE, WINDOW_CLOSE, WINDOW_WILL_CLOSE } from "@shared/channels";
import { isSerializedAppError } from "@shared/errors";

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

  it("passes the request id back on close and rejections through unchanged", async () => {
    void api.window.close(3);
    expect(mocks.invoke).toHaveBeenCalledWith(WINDOW_CLOSE, 3);

    mocks.invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(api.files.read("big.excalidraw")).rejects.toThrow("boom");
    expect(mocks.invoke).toHaveBeenCalledWith(FILES_READ, "big.excalidraw");
  });

  it("reconstructs serialized app errors so renderer-side guards recognize them", async () => {
    mocks.invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        $isAppError: true,
        name: "Error",
        message: "Disk full",
        code: "TOO_LARGE",
        operation: "save",
        retryable: true,
      },
    });

    const error = await api.files.write("big.excalidraw", "{}").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isSerializedAppError(error)).toBe(true);
    expect((error as Error).message).toBe("Disk full");
    expect(mocks.invoke).toHaveBeenCalledWith(FILES_WRITE, "big.excalidraw", "{}");
  });
});
