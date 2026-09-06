import { Buffer } from "node:buffer";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  APP_QUIT,
  CONTEXT_MENU_SHOW,
  DIALOG_FILE_CHANGED,
  DIALOG_FILE_RECOVER,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_CREATE,
  FILES_DELETE,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  FILES_WRITE_RECOVER,
  SETTINGS_GET,
  SETTINGS_SET,
  STORE_DELETE,
  STORE_GET,
  STORE_SET,
  THUMBNAILS_GET,
  THUMBNAILS_PUT,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_READY,
  WINDOW_REPORT_FATAL,
} from "@shared/channels";
import {
  errorWithCode,
  isRecord,
  isSerializedAppError,
  toRendererSafe,
  toSerialized,
} from "@shared/errors";
import type { ErrorOperation, SerializedAppError } from "@shared/errors";
import { MAX_DRAWING_CONTENT_BYTES, MAX_THUMBNAIL_BATCH } from "@shared/ipc";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  FileDeleteMode,
  FileEntry,
  SettingsUpdate,
  ThumbnailRecord,
  UnsavedChoice,
  UnsavedReason,
} from "@shared/ipc";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";

import { log } from "./logger";
import { validateSettingsUpdate } from "./settings";
import { store } from "./store";
import { isValidThumbnailRecord } from "./thumbnails";

export const APP_ORIGIN = "app://renderer";
export const APP_HOST = "renderer";
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
export const APP_GREETING_URL = `${APP_ORIGIN}/greeting.html`;
export const MAX_LIBRARY_STORE_BYTES = 2 * 1024 * 1024;

let lastFatalAt = 0;

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw errorWithCode(`${field} must be a non-empty string`, "INVALID");
  }
  return value;
};

const requireOptionalString = (value: unknown, field: string) => {
  if (value === null) return null;
  return requireString(value, field);
};

const requireBoolean = (value: unknown, field: string) => {
  if (typeof value !== "boolean") {
    throw errorWithCode(`${field} must be a boolean`, "INVALID");
  }
  return value;
};

const requireContent = (value: unknown, field: string) => {
  const content = requireString(value, field);
  if (Buffer.byteLength(content, "utf8") > MAX_DRAWING_CONTENT_BYTES) {
    throw errorWithCode(`Content exceeds ${MAX_DRAWING_CONTENT_BYTES} bytes`, "TOO_LARGE");
  }
  return content;
};

const requireIdArray = (value: unknown) => {
  if (!Array.isArray(value)) throw errorWithCode("ids must be an array", "INVALID");
  if (value.length > MAX_THUMBNAIL_BATCH) {
    throw errorWithCode(`Too many ids, max ${MAX_THUMBNAIL_BATCH}`, "INVALID");
  }
  return [...new Set(value.map((item) => requireString(item, "id")))];
};

const requireDeleteMode = (value: unknown): FileDeleteMode => {
  if (value !== "trash" && value !== "permanent") {
    throw errorWithCode("Delete mode must be trash or permanent", "INVALID");
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

const requireContextMenuRequest = (request: unknown) => {
  if (!isRecord(request)) {
    throw errorWithCode("Context menu request must be an object", "INVALID");
  }
  const { items, x, y } = request;
  if (!Array.isArray(items) || items.length === 0) {
    throw errorWithCode("Context menu items must be a non-empty array", "INVALID");
  }
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw errorWithCode("Context menu position must be finite numbers", "INVALID");
  }
  return {
    items: items.map((item) => {
      if (!isRecord(item)) {
        throw errorWithCode("Context menu item must be an object", "INVALID");
      }
      if (typeof item.id !== "string" || item.id.length === 0) {
        throw errorWithCode("Context menu item id must be a non-empty string", "INVALID");
      }
      if (typeof item.label !== "string" || item.label.length === 0) {
        throw errorWithCode("Context menu item label must be a non-empty string", "INVALID");
      }
      return { id: item.id, label: item.label };
    }),
    x,
    y,
  };
};

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

export const installAppProtocolHandler = () => {
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
  writeDrawingFile: (id: string, content: string) => Promise<FileEntry>;
  writeDrawingFileRecover: (id: string, content: string) => Promise<FileEntry>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  createEntry: (
    parentId: string | null,
    name: string,
    kind: "file" | "directory",
  ) => Promise<FileEntry>;
  deleteEntry: (id: string, mode: FileDeleteMode) => Promise<void>;
  destroyWindow: (win: BrowserWindow, requestId: number) => void;
  markWindowReady: (win: BrowserWindow) => void;
  cancelQuit: (win: BrowserWindow, requestId: number) => void;
  onDirtyState: (
    win: BrowserWindow,
    requestId: number,
    dirty: boolean,
    skipPrompt: boolean,
  ) => void;
  onFlushStarted: (win: BrowserWindow, requestId: number) => void;
  showUnsavedChangesDialog: (
    win: BrowserWindow | null,
    reason: UnsavedReason,
  ) => Promise<UnsavedChoice>;
  getSettings: () => AppSettings;
  updateSettings: (update: SettingsUpdate) => AppSettings;
  getThumbnails: (ids: string[]) => Promise<ThumbnailRecord[]>;
  saveThumbnail: (record: ThumbnailRecord) => Promise<void>;
};

const windowFromEvent = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
};

export const isTrustedRendererUrl = (urlString: string) => {
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

export const normalizeContextMenuPos = (x: number, y: number, zoomFactor: number) => {
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

function assertRendererStoreKey(key: unknown): asserts key is "lastOpenedFileId" | "libraryItems" {
  if (key !== "lastOpenedFileId" && key !== "libraryItems") {
    throw new Error("Store key is not allowed");
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: SerializedAppError };

const withIpcResult = async <T>(
  operation: ErrorOperation,
  fn: () => Promise<T> | T,
): Promise<Result<T>> => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const full = toSerialized(error, operation);
    const safe = toRendererSafe(full);
    if (full.code === "UNKNOWN") {
      log.warn("[ipc:error]", operation, full);
    } else {
      log.debug("[ipc:error]", operation, safe);
    }
    return { ok: false, error: safe };
  }
};

export const shouldQuitAfterFatal = (now = Date.now()) => {
  const previous = lastFatalAt;
  lastFatalAt = now;
  return previous === 0 || now - previous >= 60_000;
};

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
    return typeof value === "string" ? value : null;
  });

  handle(STORE_SET, "unexpected", (_event, ...args) => {
    const key = args[0];
    assertRendererStoreKey(key);

    let value: string | null;
    if (key === "libraryItems") {
      const raw = args[1];
      if (raw === null) {
        value = null;
      } else {
        if (typeof raw !== "string" || raw.length === 0) {
          throw errorWithCode("value must be a non-empty string", "INVALID");
        }
        if (Buffer.byteLength(raw, "utf8") > MAX_LIBRARY_STORE_BYTES) {
          throw errorWithCode(
            `Library is too large to store (max ${MAX_LIBRARY_STORE_BYTES} bytes)`,
            "TOO_LARGE",
          );
        }
        value = raw;
      }
    } else {
      value = requireOptionalString(args[1], "value");
    }

    store.set(key, value);
  });

  handle(STORE_DELETE, "unexpected", (_event, ...args) => {
    const key = args[0];
    assertRendererStoreKey(key);
    store.delete(key);
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

  handle(FILES_CREATE, "create", (_event, ...args) => {
    const parentRaw = args[0];
    const parentId = parentRaw === null ? null : requireString(parentRaw, "parentId");
    const name = requireString(args[1], "name");
    const kindRaw = args[2];
    if (kindRaw !== "file" && kindRaw !== "directory") {
      throw errorWithCode("Kind must be file or directory", "INVALID");
    }
    return deps.createEntry(parentId, name, kindRaw);
  });

  handle(FILES_WRITE, "save", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const content = requireContent(args[1], "content");
    return deps.writeDrawingFile(id, content);
  });

  handle(FILES_DELETE, "delete", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const mode = args[1] === undefined ? "trash" : requireDeleteMode(args[1]);
    return deps.deleteEntry(id, mode);
  });

  handle(DRAWINGS_PICK, "load", (event) => deps.pickDrawings(windowFromEvent(event)));
  handle(APP_QUIT, "unexpected", () => app.quit());

  handle(CONTEXT_MENU_SHOW, "unexpected", async (event, ...args) => {
    const win = windowFromEvent(event);
    if (!win) return null;

    const { items, x: xRaw, y: yRaw } = requireContextMenuRequest(args[0]);

    return new Promise<string | null>((resolveSelection) => {
      let resolved = false;
      const settle = (value: string | null) => {
        if (resolved) return;
        resolved = true;
        resolveSelection(value);
      };

      const template = items.map((item) => ({
        label: item.label,
        enabled: true,
        click: () => settle(item.id),
      }));

      const menu = Menu.buildFromTemplate(template);
      const zoomFactor = win.webContents.getZoomFactor();
      const position = normalizeContextMenuPos(xRaw, yRaw, zoomFactor);

      win.once("closed", () => settle(null));

      menu.popup({
        window: win,
        ...position,
        callback: () => settle(null),
      });
    });
  });

  handle(SETTINGS_GET, "settings", () => deps.getSettings());

  handle(SETTINGS_SET, "settings", (_event, ...args) => {
    const payload = args[0];
    if (!isRecord(payload)) throw errorWithCode("Settings update must be an object", "INVALID");
    return deps.updateSettings(validateSettingsUpdate(payload));
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
    if (win)
      deps.onDirtyState(
        win,
        requireInteger(args[0], "requestId"),
        requireBoolean(args[1], "dirty"),
        args[2] === undefined ? false : requireBoolean(args[2], "skipPrompt"),
      );
  });

  on(WINDOW_FLUSH_STARTED, (event, ...args) => {
    const win = windowFromEvent(event);
    if (win) deps.onFlushStarted(win, requireInteger(args[0], "requestId"));
  });

  handle(DIALOG_UNSAVED_CHANGES, "unexpected", (event, ...args) => {
    const reason = args[0];
    const normalized = reason === "switch" ? "switch" : "quit";
    return deps.showUnsavedChangesDialog(windowFromEvent(event), normalized);
  });

  handle(FILES_WRITE_RECOVER, "recover", (_event, ...args) => {
    const id = requireString(args[0], "id");
    const content = requireContent(args[1], "content");
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

  handle(THUMBNAILS_GET, "read", (_event, ...args) => deps.getThumbnails(requireIdArray(args[0])));

  handle(THUMBNAILS_PUT, "save", (_event, ...args) => {
    const record = args[0];
    if (!isValidThumbnailRecord(record)) throw errorWithCode("Invalid thumbnail record", "INVALID");

    return deps.saveThumbnail(record);
  });

  handle(WINDOW_REPORT_FATAL, "unexpected", (_event, ...args) => {
    const payload = args[0];
    if (!isSerializedAppError(payload)) throw errorWithCode("Invalid fatal payload", "INVALID");
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
          detail: payload.message,
        })
        .then(({ response }) => {
          if (response === 0) app.quit();
        });
    }
  });
};
