import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  isPackaged: false,
  netFetch: vi.fn(),
  protocolHandle: vi.fn(),
  menuPopup: vi.fn(),
  menuTemplate: null as Array<{ click?: () => void }> | null,
  store: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: {},
  ipcMain: { handle: mocks.handle, on: mocks.on },
  Menu: {
    buildFromTemplate: (template: Array<{ click?: () => void }>) => {
      mocks.menuTemplate = template;
      return {
        popup: (options: { callback?: () => void }) => {
          mocks.menuPopup(options);
        },
      };
    },
  },
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
  DRAWINGS_LOAD,
  FILES_READ,
  STORE_DELETE,
  STORE_GET,
  STORE_SET,
  THUMBNAILS_GET,
  THUMBNAILS_PUT,
  WINDOW_CLOSE,
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

  it("rejects untrusted urls", () => {
    expect(isTrustedRendererUrl("app://evil/index.html")).toBe(false);
    expect(isTrustedRendererUrl("file:///etc/passwd")).toBe(false);
    expect(isTrustedRendererUrl("file:///home/user/out/renderer/index.html")).toBe(false);
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

  it("serves index.html for the root path", async () => {
    const res = await get("app://renderer/");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/));
  });

  it("serves files within the renderer directory, including encoded slashes", async () => {
    const res = await get("app://renderer/src/main.tsx");
    expect(res.status).toBe(200);
    expect(mocks.netFetch).toHaveBeenCalledWith(expect.stringMatching(/src[\\/]main\.tsx$/));

    await get("app://renderer/assets%2Fmain.tsx");
    expect(mocks.netFetch).toHaveBeenLastCalledWith(expect.stringMatching(/assets[\\/]main\.tsx$/));
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

  it("maps upstream failures and errors to 404", async () => {
    mocks.netFetch.mockResolvedValue(new Response("missing", { status: 404 }));
    const res = await get("app://renderer/missing.js");
    expect(res.status).toBe(404);

    mocks.netFetch.mockRejectedValue(new Error("boom"));
    const errRes = await get("app://renderer/error.js");
    expect(errRes.status).toBe(404);
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
  createEntry: vi.fn(),
  deleteEntry: vi.fn(),
  destroyWindow: vi.fn(),
  markWindowReady: vi.fn(),
  cancelQuit: vi.fn(),
  onDirtyState: vi.fn(),
  onFlushStarted: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getThumbnails: vi.fn(),
  saveThumbnail: vi.fn(async () => undefined),
};

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const listeners = new Map<string, (...args: unknown[]) => void>();

const eventFor = () => ({ sender: {} }) as Electron.IpcMainInvokeEvent;

describe("registerIpcHandlers wiring", () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReset().mockReturnValue({
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { getZoomFactor: () => 1 },
    });
    mocks.store.get.mockReset();
    mocks.store.set.mockReset();
    mocks.store.delete.mockReset();
    for (const fn of Object.values(deps)) fn.mockReset();

    handlers.clear();
    listeners.clear();
    mocks.handle.mockClear();
    mocks.on.mockClear();
    mocks.menuPopup.mockClear();
    mocks.menuTemplate = null;
    mocks.handle.mockImplementation((channel, listener) => handlers.set(channel, listener));
    mocks.on.mockImplementation((channel, listener) => listeners.set(channel, listener));

    registerIpcHandlers(deps);
  });

  const thumbnailRecord = {
    fileId: "a.excalidraw",
    mtimeMs: 1,
    size: 2,
    light: "data:image/png;base64,AAAA",
    dark: "data:image/png;base64,BBBB",
  };

  it("serves thumbnail records through the get channel", async () => {
    deps.getThumbnails.mockResolvedValue([thumbnailRecord]);

    await expect(handlers.get(THUMBNAILS_GET)!(eventFor(), ["a.excalidraw"])).resolves.toEqual({
      ok: true,
      value: [thumbnailRecord],
    });
    expect(deps.getThumbnails).toHaveBeenCalledWith(["a.excalidraw"]);
  });

  it("rejects invalid thumbnail get requests", async () => {
    await expect(handlers.get(THUMBNAILS_GET)!(eventFor(), "not-an-array")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(
      handlers.get(THUMBNAILS_GET)!(
        eventFor(),
        Array.from({ length: 501 }, () => "x"),
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    await expect(handlers.get(THUMBNAILS_GET)!(eventFor(), [""])).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("validates thumbnail put payloads", async () => {
    await expect(handlers.get(THUMBNAILS_PUT)!(eventFor(), thumbnailRecord)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(deps.saveThumbnail).toHaveBeenCalledWith(thumbnailRecord);

    await expect(handlers.get(THUMBNAILS_PUT)!(eventFor(), { fileId: "x" })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(handlers.get(THUMBNAILS_PUT)!(eventFor(), "nope")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    const oversizedLight = {
      ...thumbnailRecord,
      light: `data:image/png;base64,${"A".repeat(512 * 1024 + 1)}`,
    };
    await expect(handlers.get(THUMBNAILS_PUT)!(eventFor(), oversizedLight)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("validates the close request id before destroying the window", async () => {
    void handlers.get(WINDOW_CLOSE)!(eventFor(), 5);
    expect(deps.destroyWindow).toHaveBeenCalledWith(expect.any(Object), 5);

    await expect(handlers.get(WINDOW_CLOSE)!(eventFor(), -1)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(handlers.get(WINDOW_CLOSE)!(eventFor(), "5")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(deps.destroyWindow).toHaveBeenCalledTimes(1);
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
  });

  it("allows recentFileIds store access and rejects non-string values", async () => {
    mocks.store.set.mockClear();
    await expect(
      handlers.get(STORE_SET)!(eventFor(), "recentFileIds", '["b","a"]'),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(mocks.store.set).toHaveBeenCalledWith("recentFileIds", '["b","a"]');

    mocks.store.set.mockClear();
    await expect(handlers.get(STORE_SET)!(eventFor(), "recentFileIds", ["b"])).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: "value must be a non-empty string" }),
    });
    expect(mocks.store.set).not.toHaveBeenCalled();

    await expect(handlers.get(STORE_GET)!(eventFor(), "recentFileIds")).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(mocks.store.get).toHaveBeenCalledWith("recentFileIds");

    await expect(handlers.get(STORE_DELETE)!(eventFor(), "recentFileIds")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mocks.store.delete).toHaveBeenCalledWith("recentFileIds");

    await expect(handlers.get(STORE_GET)!(eventFor(), "unknownKey")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Store key is not allowed" }),
      }),
    );
  });

  it("rejects invalid store values across allowed keys", async () => {
    for (const key of ["lastOpenedFileId", "recentFileIds"] as const) {
      for (const bad of [42, ["x"], {}, true, ""]) {
        await expect(handlers.get(STORE_SET)!(eventFor(), key, bad)).resolves.toEqual(
          expect.objectContaining({ ok: false }),
        );
      }
    }
    expect(mocks.store.set).not.toHaveBeenCalled();
  });

  it("rejects malformed context menu items", async () => {
    const handler = handlers.get(CONTEXT_MENU_SHOW)!;

    const badRequests: unknown[] = [
      { items: [], x: 0, y: 0 },
      { items: ["rename"], x: 0, y: 0 },
      { items: [{ id: "rename" }], x: 0, y: 0 },
      { items: [{ id: "rename", label: "" }], x: 0, y: 0 },
      { items: [{ id: 7, label: "Rename" }], x: 0, y: 0 },
      {
        items: Array.from({ length: 33 }, (_, index) => ({ id: `m${index}`, label: `M${index}` })),
        x: 0,
        y: 0,
      },
    ];

    for (const request of badRequests) {
      await expect(handler(eventFor(), request)).resolves.toEqual(
        expect.objectContaining({ ok: false }),
      );
    }

    expect(mocks.menuPopup).not.toHaveBeenCalled();
  });

  it("resolves the context menu with the clicked item id", async () => {
    const handler = handlers.get(CONTEXT_MENU_SHOW)!;
    const pending = handler(eventFor(), {
      items: [
        { id: "rename", label: "Rename" },
        { id: "delete", label: "Delete" },
      ],
      x: 10,
      y: 20,
    });

    expect(mocks.menuPopup).toHaveBeenCalledTimes(1);
    expect(mocks.menuPopup).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 20 }));

    mocks.menuTemplate![1].click?.();
    await expect(pending).resolves.toEqual({ ok: true, value: "delete" });
  });

  it("resolves the context menu with null when dismissed without a selection", async () => {
    const handler = handlers.get(CONTEXT_MENU_SHOW)!;
    const pending = handler(eventFor(), { items: [{ id: "rename", label: "Rename" }], x: 0, y: 0 });

    const popupOptions = mocks.menuPopup.mock.lastCall?.[0] as
      | { callback?: () => void }
      | undefined;
    popupOptions?.callback?.();

    await expect(pending).resolves.toEqual({ ok: true, value: null });
  });

  it("rejects malformed context menu requests", async () => {
    const handler = handlers.get(CONTEXT_MENU_SHOW)!;

    await expect(handler(eventFor(), { items: "nope", x: 0, y: 0 })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(mocks.menuPopup).not.toHaveBeenCalled();

    const negative = handler(eventFor(), {
      items: [{ id: "rename", label: "Rename" }],
      x: -5,
      y: 0,
    });
    const popupOptions = mocks.menuPopup.mock.lastCall?.[0] as
      | { callback?: () => void }
      | undefined;
    popupOptions?.callback?.();

    await expect(negative).resolves.toEqual({ ok: true, value: null });
  });

  it("skips deps when the sender is not a live BrowserWindow", () => {
    mocks.fromWebContents.mockReturnValue(null);
    listeners.get(WINDOW_READY)!(eventFor());
    expect(deps.markWindowReady).not.toHaveBeenCalled();

    void handlers.get(WINDOW_CLOSE)!(eventFor(), 5);
    expect(deps.destroyWindow).not.toHaveBeenCalled();
  });
});

describe("registerIpcHandlers error propagation", () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReset().mockReturnValue({ isDestroyed: () => false });
    mocks.store.get.mockReset();
    mocks.store.set.mockReset();
    mocks.store.delete.mockReset();
    for (const fn of Object.values(deps)) fn.mockReset();

    handlers.clear();
    listeners.clear();
    mocks.handle.mockClear();
    mocks.on.mockClear();
    mocks.handle.mockImplementation((channel, listener) => handlers.set(channel, listener));
    mocks.on.mockImplementation((channel, listener) => listeners.set(channel, listener));

    registerIpcHandlers(deps);
  });

  it("propagates handler failures and successes uniformly", async () => {
    deps.readDrawingFile.mockRejectedValue(new Error("Drawing content is not valid JSON"));

    await expect(handlers.get(FILES_READ)!(eventFor(), "broken.excalidraw")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Drawing content is not valid JSON" }),
      }),
    );

    deps.loadDrawings.mockResolvedValue({ info: { configured: true }, entries: [] });
    await expect(handlers.get(DRAWINGS_LOAD)!(eventFor())).resolves.toEqual({
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
