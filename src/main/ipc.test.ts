import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  isPackaged: false,
  netFetch: vi.fn(),
  protocolHandle: vi.fn(),
  store: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: {},
  ipcMain: { handle: mocks.handle, on: mocks.on },
  Menu: {},
  net: { fetch: mocks.netFetch },
  protocol: { handle: mocks.protocolHandle },
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
  },
}));

vi.mock("./store", () => ({ store: mocks.store }));

import {
  CONTEXT_MENU_SHOW,
  DIALOG_FILE_CHANGED,
  DIALOG_FILE_RECOVER,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_DELETE,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  FILES_WRITE_RECOVER,
  SETTINGS_GET,
  SETTINGS_SET,
  STORE_CLEAR,
  STORE_DELETE,
  STORE_GET,
  STORE_SET,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_READY,
} from "@shared/channels";

import {
  APP_ORIGIN,
  installAppProtocolHandler,
  isTrustedRendererUrl,
  registerIpcHandlers,
} from "./ipc";

const env = process.env as Record<string, string | undefined>;

describe("isTrustedRendererUrl", () => {
  beforeEach(() => {
    mocks.isPackaged = false;
    delete env["ELECTRON_RENDERER_URL"];
  });

  it("accepts pages served by the app: protocol", () => {
    expect(isTrustedRendererUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
    expect(isTrustedRendererUrl(`${APP_ORIGIN}/greeting.html`)).toBe(true);
  });

  it("rejects app: pages outside the app host", () => {
    expect(isTrustedRendererUrl("app://evil/index.html")).toBe(false);
  });

  it("rejects file: pages even inside the renderer directory", () => {
    expect(isTrustedRendererUrl("file:///etc/passwd")).toBe(false);
    expect(isTrustedRendererUrl("file:///home/user/out/renderer/index.html")).toBe(false);
  });

  it("rejects malformed urls", () => {
    expect(isTrustedRendererUrl("not a url")).toBe(false);
  });

  it("requires the configured development renderer origin in dev", () => {
    env["ELECTRON_RENDERER_URL"] = "http://localhost:5173/";
    expect(isTrustedRendererUrl("http://localhost:5173/greeting.html")).toBe(true);
    expect(isTrustedRendererUrl("https://untrusted.example/")).toBe(false);
  });

  it("ignores ELECTRON_RENDERER_URL when packaged", () => {
    mocks.isPackaged = true;
    env["ELECTRON_RENDERER_URL"] = "http://localhost:5173/";

    expect(isTrustedRendererUrl("http://localhost:5173/greeting.html")).toBe(false);
    expect(isTrustedRendererUrl(`${APP_ORIGIN}/index.html`)).toBe(true);
  });
});

type AppProtocolHandler = (request: Request) => Response | Promise<Response>;

const appSchemes = new Map<string, AppProtocolHandler>();

describe("installAppProtocolHandler", () => {
  beforeEach(() => {
    mocks.netFetch.mockReset().mockResolvedValue(new Response("ok"));
    mocks.protocolHandle.mockReset();
    mocks.protocolHandle.mockImplementation((scheme, handler) => appSchemes.set(scheme, handler));

    installAppProtocolHandler();
  });

  const get = async (url: string): Promise<Response> => appSchemes.get("app")!(new Request(url));

  it("registers a handler for the app scheme", () => {
    expect(appSchemes.has("app")).toBe(true);
  });

  it("serves index.html for the root path", async () => {
    const res = await get("app://renderer/");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/));
  });

  it("serves files within the renderer directory", async () => {
    const res = await get("app://renderer/src/main.tsx");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/src[\\/]main\.tsx$/));
  });

  it("serves index.html for directory paths", async () => {
    await get("app://renderer/assets/");
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/assets[\\/]index\.html$/));
  });

  it("resolves dot segments that stay inside the renderer directory", async () => {
    const res = await get("app://renderer/assets/../index.html");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/));
  });

  it("serves files requested with encoded slashes", async () => {
    const res = await get("app://renderer/assets%2Fmain.tsx");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/assets[\\/]main\.tsx$/));
  });

  it("rejects requests for other hosts without touching the filesystem", async () => {
    const res = await get("app://evil/index.html");
    expect(res.status).toBe(404);
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("rejects paths escaping the renderer directory", async () => {
    for (const path of [
      "..%2fsecret.txt",
      "..%2f..%2fetc%2fpasswd",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ]) {
      const res = await get(`app://renderer/${path}`);
      expect(res.status, path).toBe(403);
    }
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed percent encodings", async () => {
    const res = await get("app://renderer/%");
    expect(res.status).toBe(400);
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it("maps upstream failures to 404", async () => {
    mocks.netFetch.mockResolvedValue(new Response("missing", { status: 404 }));
    const res = await get("app://renderer/missing.js");
    expect(res.status).toBe(404);
  });

  it("maps upstream errors to 404", async () => {
    mocks.netFetch.mockRejectedValue(new Error("boom"));
    const res = await get("app://renderer/error.js");
    expect(res.status).toBe(404);
  });
});

const deps = {
  getDrawings: vi.fn(),
  loadDrawings: vi.fn(),
  listEntries: vi.fn(),
  pickDrawings: vi.fn(),
  readDrawingFile: vi.fn(),
  writeDrawingFile: vi.fn(),
  writeDrawingFileRecover: vi.fn(),
  renameEntry: vi.fn(),
  deleteEntry: vi.fn(),
  destroyWindow: vi.fn(),
  markWindowReady: vi.fn(),
  cancelQuit: vi.fn(),
  onDirtyState: vi.fn(),
  onFlushStarted: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
};

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const listeners = new Map<string, (...args: unknown[]) => void>();

const eventFor = () => ({ sender: {} }) as Electron.IpcMainInvokeEvent;

describe("registerIpcHandlers wiring", () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
    mocks.store.get.mockReset();
    mocks.store.set.mockReset();
    mocks.store.delete.mockReset();
    mocks.store.clear.mockReset();
    for (const fn of Object.values(deps)) fn.mockReset();

    handlers.clear();
    listeners.clear();
    mocks.handle.mockClear();
    mocks.on.mockClear();
    mocks.handle.mockImplementation((channel, listener) => handlers.set(channel, listener));
    mocks.on.mockImplementation((channel, listener) => listeners.set(channel, listener));

    registerIpcHandlers(deps);
  });

  it("registers every invoke channel via ipcMain.handle", () => {
    const invokeChannels = [
      CONTEXT_MENU_SHOW,
      DIALOG_FILE_CHANGED,
      DIALOG_FILE_RECOVER,
      DIALOG_UNSAVED_CHANGES,
      DRAWINGS_GET,
      DRAWINGS_LOAD,
      DRAWINGS_PICK,
      FILES_DELETE,
      FILES_LIST,
      FILES_READ,
      FILES_RENAME,
      FILES_WRITE,
      FILES_WRITE_RECOVER,
      SETTINGS_GET,
      SETTINGS_SET,
      STORE_CLEAR,
      STORE_DELETE,
      STORE_GET,
      STORE_SET,
      WINDOW_CLOSE,
    ];
    for (const channel of invokeChannels) {
      expect(handlers.has(channel), channel).toBe(true);
    }
  });

  it("registers every send-style channel via ipcMain.on", () => {
    const sendChannels = [
      WINDOW_READY,
      WINDOW_CANCEL_QUIT,
      WINDOW_DIRTY_STATE,
      WINDOW_FLUSH_STARTED,
    ];
    for (const channel of sendChannels) {
      expect(listeners.has(channel), channel).toBe(true);
    }
  });

  it("forwards the close request id to destroyWindow", () => {
    void handlers.get(WINDOW_CLOSE)!(eventFor(), 5);
    expect(deps.destroyWindow).toHaveBeenCalledWith(expect.any(Object), 5);
  });

  it("forwards the cancel-quit request id to cancelQuit", () => {
    listeners.get(WINDOW_CANCEL_QUIT)!(eventFor(), 6);
    expect(deps.cancelQuit).toHaveBeenCalledWith(expect.any(Object), 6);
  });

  it("forwards dirty-state and flush-started messages to the deps", () => {
    listeners.get(WINDOW_DIRTY_STATE)!(eventFor(), 7, true);
    expect(deps.onDirtyState).toHaveBeenCalledWith(expect.any(Object), 7, true);

    listeners.get(WINDOW_FLUSH_STARTED)!(eventFor(), 9);
    expect(deps.onFlushStarted).toHaveBeenCalledWith(expect.any(Object), 9);
  });

  it("allows lastOpenedFileId store access and rejects other keys", async () => {
    mocks.store.get.mockReturnValue("file-1");
    await expect(handlers.get(STORE_GET)!(eventFor(), "lastOpenedFileId")).resolves.toEqual({
      ok: true,
      value: "file-1",
    });
    expect(mocks.store.get).toHaveBeenCalledWith("lastOpenedFileId");

    await expect(
      handlers.get(STORE_SET)!(eventFor(), "lastOpenedFileId", "file-2"),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mocks.store.set).toHaveBeenCalledWith("lastOpenedFileId", "file-2");

    await expect(handlers.get(STORE_DELETE)!(eventFor(), "lastOpenedFileId")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mocks.store.delete).toHaveBeenCalledWith("lastOpenedFileId");

    await expect(handlers.get(STORE_GET)!(eventFor(), "drawingsPath")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Store key is not allowed" }),
      }),
    );
    await expect(handlers.get(STORE_SET)!(eventFor(), "theme", "dark")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Store key is not allowed" }),
      }),
    );
    await expect(handlers.get(STORE_DELETE)!(eventFor(), "zoomLevel")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Store key is not allowed" }),
      }),
    );
    await expect(handlers.get(STORE_CLEAR)!(eventFor())).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Store clear is not allowed" }),
      }),
    );
    expect(mocks.store.clear).not.toHaveBeenCalled();
  });

  it("forwards invoke messages to the dep and returns the result", async () => {
    const handler = handlers.get(DRAWINGS_GET)!;
    deps.getDrawings.mockResolvedValue("drawings");
    await expect(handler(eventFor())).resolves.toEqual({ ok: true, value: "drawings" });
    expect(deps.getDrawings).toHaveBeenCalledTimes(1);
  });

  it("forwards invoke args to the dep", async () => {
    const handler = handlers.get(FILES_WRITE)!;
    await handler(eventFor(), "drawing-1", "content");
    expect(deps.writeDrawingFile).toHaveBeenCalledWith("drawing-1", "content");
  });

  it("forwards send-style messages to the dep", () => {
    const listener = listeners.get(WINDOW_READY)!;
    listener(eventFor());
    expect(deps.markWindowReady).toHaveBeenCalledTimes(1);

    const cancelQuit = listeners.get(WINDOW_CANCEL_QUIT)!;
    cancelQuit(eventFor(), 5);
    expect(deps.cancelQuit).toHaveBeenCalledTimes(1);
  });

  it("skips deps when the sender is not a live BrowserWindow", () => {
    mocks.fromWebContents.mockReturnValue(null);
    listeners.get(WINDOW_READY)!(eventFor());
    expect(deps.markWindowReady).not.toHaveBeenCalled();

    const handler = handlers.get(DRAWINGS_GET)!;
    deps.getDrawings.mockResolvedValue("drawings");
    void handler(eventFor());
    expect(deps.getDrawings).toHaveBeenCalledTimes(1);
  });
});

describe("registerIpcHandlers error propagation", () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
    mocks.store.get.mockReset();
    mocks.store.set.mockReset();
    mocks.store.delete.mockReset();
    mocks.store.clear.mockReset();
    for (const fn of Object.values(deps)) fn.mockReset();

    handlers.clear();
    listeners.clear();
    mocks.handle.mockClear();
    mocks.on.mockClear();
    mocks.handle.mockImplementation((channel, listener) => handlers.set(channel, listener));
    mocks.on.mockImplementation((channel, listener) => listeners.set(channel, listener));

    registerIpcHandlers(deps);
  });

  it("propagates handler rejections as plain errors", async () => {
    const handler = handlers.get(FILES_READ)!;
    deps.readDrawingFile.mockRejectedValue(new Error("Drawing content is not valid JSON"));

    await expect(handler(eventFor(), "broken.excalidraw")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Drawing content is not valid JSON" }),
      }),
    );
  });

  it("propagates sync handler throws as plain errors", async () => {
    const handler = handlers.get(FILES_WRITE)!;
    deps.writeDrawingFile.mockRejectedValue(new Error("disk on fire"));

    await expect(handler(eventFor(), "a.excalidraw", "{}")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "disk on fire" }),
      }),
    );
  });

  it("propagates successful results unchanged", async () => {
    const handler = handlers.get(DRAWINGS_LOAD)!;
    deps.loadDrawings.mockResolvedValue({ info: { configured: true }, entries: [] });
    await expect(handler(eventFor())).resolves.toEqual({
      ok: true,
      value: { info: { configured: true }, entries: [] },
    });
  });

  it("catches send-style listener failures", () => {
    deps.markWindowReady.mockImplementation(() => {
      throw new Error("listener exploded");
    });

    expect(() => listeners.get(WINDOW_READY)!(eventFor())).not.toThrow();
  });
});
