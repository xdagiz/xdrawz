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
  WINDOW_READY,
} from "@shared/channels";
import type {
  AppSettings,
  ContextMenuRequest,
  DrawingInfo,
  DrawingsSnapshot,
  FileChangedChoice,
  FileEntry,
  FileRecoverChoice,
  SettingsUpdate,
  StoreKey,
  UnsavedChoice,
  UnsavedReason,
} from "@shared/ipc";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";

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
  readSceneFile: (id: string) => Promise<string>;
  writeSceneFile: (id: string, content: string) => Promise<void>;
  writeSceneFileRecover: (id: string, content: string) => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  deleteEntry: (id: string) => Promise<void>;
  destroyWindow: (win: BrowserWindow) => void;
  markWindowReady: (win: BrowserWindow) => void;
  cancelQuit: (win: BrowserWindow) => void;
  getSettings: () => AppSettings;
  updateSettings: (update: SettingsUpdate) => AppSettings;
};

const windowFromEvent = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
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

export const registerIpcHandlers = (deps: Deps): void => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());
  ipcMain.handle(DRAWINGS_LOAD, () => deps.loadDrawings());

  ipcMain.handle(STORE_GET, (_event, key: StoreKey) => {
    const value = store.get(key);
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  });

  ipcMain.handle(STORE_SET, (_event, key: StoreKey, value: string | null) => store.set(key, value));
  ipcMain.handle(STORE_DELETE, (_event, key: StoreKey) => store.delete(key));
  ipcMain.handle(STORE_CLEAR, () => store.clear());

  ipcMain.handle(FILES_LIST, () => deps.listEntries());
  ipcMain.handle(FILES_READ, (_event, id: string) => deps.readSceneFile(id));
  ipcMain.handle(FILES_RENAME, (_event, id: string, newName: string) =>
    deps.renameEntry(id, newName),
  );
  ipcMain.handle(FILES_WRITE, (_event, id: string, content: string) =>
    deps.writeSceneFile(id, content),
  );
  ipcMain.handle(FILES_DELETE, (_event, id: string) => deps.deleteEntry(id));

  ipcMain.handle(DRAWINGS_PICK, (event) => deps.pickDrawings(windowFromEvent(event)));

  ipcMain.handle(CONTEXT_MENU_SHOW, (event, request: ContextMenuRequest) => {
    const win = windowFromEvent(event);
    if (!win) return null;

    return new Promise<string | null>((resolve) => {
      let resolved = false;

      const template = request.items.map((item) => ({
        label: item.label,
        enabled: true,
        click: () => {
          resolved = true;
          resolve(item.id);
        },
      }));

      const menu = Menu.buildFromTemplate(template);
      const zoomFactor = win.webContents.getZoomFactor();
      const position = normalizeContextMenuPos(request.x, request.y, zoomFactor);

      menu.popup({
        window: win,
        ...position,
        callback: () => {
          if (!resolved) resolve(null);
        },
      });
    });
  });

  ipcMain.handle(SETTINGS_GET, () => deps.getSettings());
  ipcMain.handle(SETTINGS_SET, (_event, update: SettingsUpdate) => deps.updateSettings(update));

  ipcMain.handle(WINDOW_CLOSE, (event) => {
    const win = windowFromEvent(event);
    if (!win) return;
    deps.destroyWindow(win);
  });

  ipcMain.on(WINDOW_READY, (event) => {
    const win = windowFromEvent(event);
    if (win) deps.markWindowReady(win);
  });

  ipcMain.on(WINDOW_CANCEL_QUIT, (event) => {
    const win = windowFromEvent(event);
    if (win) deps.cancelQuit(win);
  });

  ipcMain.handle(DIALOG_UNSAVED_CHANGES, (event, reason: UnsavedReason = "quit") => {
    const win = windowFromEvent(event);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Save", "Don't save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "You have unsaved changes.",
      detail:
        reason === "switch"
          ? "Do you want to save before leaving this drawing?"
          : "Do you want to save before quitting?",
    };

    const doShow = async (): Promise<UnsavedChoice> => {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      if (response === 0) return "save";
      if (response === 1) return "discard";
      return "cancel";
    };

    return doShow();
  });

  ipcMain.handle(FILES_WRITE_RECOVER, (_event, id: string, content: string) =>
    deps.writeSceneFileRecover(id, content),
  );

  ipcMain.handle(DIALOG_FILE_RECOVER, (event, fileName: string) => {
    const win = windowFromEvent(event);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Recover file", "Discard changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was deleted on disk.`,
    };

    const doShow = async (): Promise<FileRecoverChoice> => {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);

      if (response === 0) return "recover";
      if (response === 1) return "discard";
      return "cancel";
    };

    return doShow();
  });

  ipcMain.handle(DIALOG_FILE_CHANGED, (event, fileName: string) => {
    const win = windowFromEvent(event);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Reload from disk", "Keep my changes", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `"${fileName}" was changed on disk.`,
      detail:
        "You have unsaved edits in this drawing. Reload discards your edits; keep writes your version to disk now.",
    };

    const doShow = async (): Promise<FileChangedChoice> => {
      const { response } = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);

      if (response === 0) return "reload";
      if (response === 1) return "overwrite";
      return "cancel";
    };

    return doShow();
  });
};
