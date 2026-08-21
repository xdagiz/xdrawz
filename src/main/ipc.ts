import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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
  WINDOW_REPORT_FATAL,
} from "@shared/channels";
import { errorWithCode, isSerializedAppError } from "@shared/errors";
import type { ErrorOperation } from "@shared/errors";
import type { AppSettings, DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";

import { showUnsavedChangesDialog } from "./close-guard";
import { shouldQuitAfterFatal, withIpcResult } from "./errors";
import { log } from "./logger";
import { store } from "./store";

export const APP_ORIGIN = "app://renderer";
export const APP_HOST = "renderer";
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
export const APP_GREETING_URL = `${APP_ORIGIN}/greeting.html`;

export const registerAppScheme = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
};

const rendererDir = join(import.meta.dirname, "../renderer");

const pageFor = (pathname: string) => {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const withIndex = relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
  const filePath = resolve(rendererDir, withIndex);
  if (filePath !== rendererDir && !filePath.startsWith(rendererDir + sep)) return null;
  return filePath;
};

export const installAppProtocolHandler = (): void => {
  protocol.handle("app", async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });

    let filePath: string | null;
    try {
      filePath = pageFor(url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (filePath === null) return new Response("Forbidden", { status: 403 });

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      return response.ok ? response : new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
};

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: (root?: string) => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
  readDrawingFile: (id: string) => Promise<string>;
  writeDrawingFile: (id: string, content: string) => Promise<void>;
  writeDrawingFileRecover: (id: string, content: string) => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  deleteEntry: (id: string) => Promise<void>;
  destroyWindow: (win: BrowserWindow, requestId: number) => void;
  markWindowReady: (win: BrowserWindow) => void;
  cancelQuit: (win: BrowserWindow, requestId: number) => void;
  onDirtyState: (win: BrowserWindow, requestId: number, dirty: boolean) => void;
  onFlushStarted: (win: BrowserWindow, requestId: number) => void;
  getSettings: () => AppSettings;
  updateSettings: (update: AppSettings) => AppSettings;
};

const windowFromEvent = (
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): BrowserWindow | null => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
};

export const isTrustedRendererUrl = (urlString: string): boolean => {
  try {
    if (!app.isPackaged) {
      const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
      if (rendererUrl) {
        return new URL(urlString).origin === new URL(rendererUrl).origin;
      }
    }

    const url = new URL(urlString);
    return url.protocol === "app:" && url.host === APP_HOST;
  } catch {
    return false;
  }
};

export const normalizeContextMenuPos = (
  x: number,
  y: number,
  zoomFactor: number,
): { x: number; y: number } | null => {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(zoomFactor) ||
    x < 0 ||
    y < 0
  ) {
    return null;
  }

  return {
    x: Math.floor(x * zoomFactor),
    y: Math.floor(y * zoomFactor),
  };
};

function assertRendererStoreKey(key: unknown): asserts key is "lastOpenedFileId" {
  if (key !== "lastOpenedFileId") {
    throw new Error("Store key is not allowed");
  }
}

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw errorWithCode(`${field} must be a non-empty string`, "INVALID");
  }
  return value;
};

const requireInteger = (value: unknown, field: string) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw errorWithCode(`${field} must be a finite integer`, "INVALID");
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const handle = (
  channel: string,
  operation: ErrorOperation,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => {
  ipcMain.handle(channel, (event, ...args) =>
    withIpcResult(operation, () => listener(event, ...args)),
  );
};

const on = (
  channel: string,
  listener: (event: Electron.IpcMainEvent, ...args: unknown[]) => void,
) => {
  ipcMain.on(channel, (event, ...args) => {
    try {
      listener(event, ...args);
    } catch (error) {
      console.error(`[ipcMain.on] ${channel} listener error:`, error);
    }
  });
};

export const registerIpcHandlers = (deps: Deps) => {
  handle(DRAWINGS_GET, "load", () => deps.getDrawings());
  handle(DRAWINGS_LOAD, "load", () => deps.loadDrawings());

  handle(STORE_GET, "unexpected", (_event, ...args) => {
    const key = args[0];
    assertRendererStoreKey(key);
    const value = store.get(key);
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  });

  handle(STORE_SET, "unexpected", (_event, ...args) => {
    const key = args[0];
    const value = args[1];
    assertRendererStoreKey(key);
    let normalized: string | null = null;
    if (value === null) normalized = null;
    else if (typeof value === "string") normalized = value;
    else normalized = null;
    store.set(key, normalized);
  });

  handle(STORE_DELETE, "unexpected", (_event, ...args) => {
    const key = args[0];
    assertRendererStoreKey(key);
    store.delete(key);
  });

  handle(STORE_CLEAR, "unexpected", () => {
    throw new Error("Store clear is not allowed");
  });

  handle(FILES_LIST, "read", () => deps.listEntries());

  handle(FILES_READ, "read", (_event, ...args) => {
    const id = requireString(args[0], "id");
    return deps.readDrawingFile(id);
  });

  handle(FILES_RENAME, "rename", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const newName = requireString(args[1], "newName");
    return deps.renameEntry(id, newName);
  });

  handle(FILES_WRITE, "save", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const content = requireString(args[1], "content");
    return deps.writeDrawingFile(id, content);
  });

  handle(FILES_DELETE, "delete", (_event, ...args) => {
    const id = requireString(args[0], "id");
    return deps.deleteEntry(id);
  });

  handle(DRAWINGS_PICK, "load", (event) => deps.pickDrawings(windowFromEvent(event)));

  handle(CONTEXT_MENU_SHOW, "unexpected", async (event, ...args) => {
    const win = windowFromEvent(event);
    if (!win) return null;
    const request = args[0];
    if (!isRecord(request)) {
      throw errorWithCode("Context menu request must be an object", "INVALID");
    }
    const itemsRaw = request.items;
    const xRaw = request.x;
    const yRaw = request.y;
    if (!Array.isArray(itemsRaw)) {
      throw errorWithCode("Context menu items must be an array", "INVALID");
    }
    if (typeof xRaw !== "number" || typeof yRaw !== "number") {
      throw errorWithCode("Context menu position must be numbers", "INVALID");
    }

    return new Promise<string | null>((resolveSelection) => {
      let resolved = false;

      const template = itemsRaw.map((item) => {
        const record = isRecord(item) ? item : null;
        const rawId = record ? record.id : "";
        const id =
          typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
        const rawLabel = record ? record.label : "";
        const label = typeof rawLabel === "string" ? rawLabel : "";
        return {
          label,
          enabled: true,
          click: () => {
            resolved = true;
            resolveSelection(id);
          },
        };
      });

      const menu = Menu.buildFromTemplate(template);
      const zoomFactor = win.webContents.getZoomFactor();
      const position = normalizeContextMenuPos(xRaw, yRaw, zoomFactor);

      menu.popup({
        window: win,
        ...position,
        callback: () => {
          if (!resolved) resolveSelection(null);
        },
      });
    });
  });

  handle(SETTINGS_GET, "settings", () => deps.getSettings());

  handle(SETTINGS_SET, "settings", (_event, ...args) => {
    const update = args[0];
    if (!isRecord(update)) {
      throw errorWithCode("Settings update must be an object", "INVALID");
    }
    const themeRaw = update.theme;
    if (themeRaw !== "light" && themeRaw !== "dark" && themeRaw !== "system") {
      throw errorWithCode("Invalid theme", "INVALID");
    }
    return deps.updateSettings({ theme: themeRaw });
  });

  handle(WINDOW_CLOSE, "unexpected", (event, ...args) => {
    const win = windowFromEvent(event);
    if (!win) return;
    const requestId = requireInteger(args[0], "requestId");
    deps.destroyWindow(win, requestId);
  });

  on(WINDOW_READY, (event) => {
    const win = windowFromEvent(event);
    if (win) deps.markWindowReady(win);
  });

  on(WINDOW_CANCEL_QUIT, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.cancelQuit(win, requireInteger(args[0], "requestId"));
  });

  on(WINDOW_DIRTY_STATE, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.onDirtyState(win, requireInteger(args[0], "requestId"), Boolean(args[1]));
  });

  on(WINDOW_FLUSH_STARTED, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.onFlushStarted(win, requireInteger(args[0], "requestId"));
  });

  handle(DIALOG_UNSAVED_CHANGES, "unexpected", (event, ...args) => {
    const reason = args[0];
    const normalized = reason === "switch" ? "switch" : "quit";
    return showUnsavedChangesDialog(windowFromEvent(event), normalized);
  });

  handle(FILES_WRITE_RECOVER, "recover", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const content = requireString(args[1], "content");
    return deps.writeDrawingFileRecover(id, content);
  });

  handle(DIALOG_FILE_RECOVER, "unexpected", async (event, ...args) => {
    const win = windowFromEvent(event);
    const rawName = args[0];
    const fileName = typeof rawName === "string" ? rawName : "";
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Recover file", "Discard changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was deleted on disk.`,
    };

    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    if (response === 0) return "recover";
    if (response === 1) return "discard";
    return "cancel";
  });

  handle(DIALOG_FILE_CHANGED, "unexpected", async (event, ...args) => {
    const win = windowFromEvent(event);
    const rawName = args[0];
    const fileName = typeof rawName === "string" ? rawName : "";
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Reload from disk", "Keep my changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was changed on disk.`,
      detail:
        "You have unsaved edits in this drawing. Reload discards your edits; keep writes your version to disk now.",
    };

    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);

    if (response === 0) return "reload";
    if (response === 1) return "overwrite";
    return "cancel";
  });

  handle(WINDOW_REPORT_FATAL, "unexpected", (_event, ...args) => {
    const payload = args[0];
    if (!isSerializedAppError(payload)) {
      throw errorWithCode("Invalid fatal payload", "INVALID");
    }
    const message = typeof payload.message === "string" ? payload.message : "Unknown fatal";
    log.error("[renderer:fatal]", payload);

    const shouldQuit = shouldQuitAfterFatal(Date.now());

    if (shouldQuit) {
      void dialog
        .showMessageBox({
          type: "error",
          buttons: ["Quit", "Continue"],
          defaultId: 0,
          cancelId: 1,
          message: "xdrawz encountered a fatal error",
          detail: message,
        })
        .then(({ response }) => {
          if (response === 0) app.quit();
        });
    }
  });
};
