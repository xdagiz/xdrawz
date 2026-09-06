for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    process.emitWarning(`stdio stream error: ${error.message}`);
  });
}

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { FILES_CHANGED, WATCHER_ERROR } from "@shared/channels";
import type { FilesChangedEvent, WatcherErrorEvent } from "@shared/ipc";
import {
  app,
  dialog,
  session,
  shell,
  nativeTheme,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

import { getDrawings, pickDrawings } from "./drawings";
import {
  createEntry,
  deleteEntry,
  listEntries,
  readDrawingFile,
  renameEntry,
  writeDrawingFile,
  writeDrawingFileRecover,
  type FsMutationHooks,
} from "./files";
import {
  installAppProtocolHandler,
  isTrustedRendererUrl,
  registerAppScheme,
  registerIpcHandlers,
} from "./ipc";
import { initLogger, log } from "./logger";
import { applyTheme, getSettings, setSettings, applyWindowBgColor } from "./settings";
import { getLastOpenedFileId } from "./store";
import { pruneThumbnailCache, readThumbnailRecords, writeThumbnailRecord } from "./thumbnails";
import { createDrawingsWatcher, type DrawingsWatcher } from "./watcher";
import {
  LIBRARY_PARTITION,
  cancelQuit,
  createGreetingWindow,
  destroyWindow,
  ensureMainWindow,
  getMainWindow,
  isCloseFlowActive,
  isQuittingNow,
  isWindowReady,
  markWindowReady,
  onDirtyState,
  onFlushStarted,
  requestQuitViaRenderer,
  showUnsavedChangesDialog,
} from "./window";

process.on("uncaughtException", (error) => {
  log.error("[main:uncaughtException]", error);
  dialog.showErrorBox("xdrawz crashed", error instanceof Error ? error.message : String(error));
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("[main:unhandledRejection]", reason);
  dialog.showErrorBox("xdrawz crashed", reason instanceof Error ? reason.message : String(reason));
  app.exit(1);
});

app.on("render-process-gone", (_event, webContents, details) => {
  if (details.reason === "clean-exit") return;
  log.error("[render-process-gone]", details);

  const win = BrowserWindow.fromWebContents(webContents);
  if (win === null || win.isDestroyed()) return;
  if (isCloseFlowActive(win)) return;

  void dialog
    .showMessageBox({
      type: "error",
      buttons: ["Reload window", "Quit"],
      defaultId: 0,
      cancelId: 1,
      message: "xdrawz renderer crashed",
      detail: `${details.reason} (${details.exitCode}). Your saved drawings are safe, but unsaved changes may be lost.`,
    })
    .then(({ response }) => {
      if (win.isDestroyed()) return;
      if (response === 0) {
        try {
          win.webContents.reload();
        } catch (error) {
          log.error("[render-process-gone] reload failed", error);
        }
        return;
      }
      app.quit();
    });
});

app.on("child-process-gone", (_event, details) => {
  log.error("[child-process-gone]", details);
});

let watcher: DrawingsWatcher | null = null;
let lastWatcherErrorAt = 0;
let queuedWatcherError: string | null = null;
let queuedWatcherTimer: NodeJS.Timeout | null = null;

const WATCHER_ERROR_INTERVAL_MS = 10_000;

const LIBRARY_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "font-src 'self' data: https://excalidraw.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const APP_ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "clipboard-read",
  "clipboard-sanitized-write",
]);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

registerAppScheme();

function broadcastFilesChanged(event: FilesChangedEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    win.webContents.send(FILES_CHANGED, event);
  }
}

function sendWatcherError(event: WatcherErrorEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    win.webContents.send(WATCHER_ERROR, event);
  }
}

function broadcastWatcherError(error: unknown) {
  log.error("[watcher]", error);

  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const remaining = WATCHER_ERROR_INTERVAL_MS - (now - lastWatcherErrorAt);

  if (remaining <= 0) {
    lastWatcherErrorAt = now;
    sendWatcherError({ message });
    return;
  }

  queuedWatcherError = message;
  if (queuedWatcherTimer) return;

  queuedWatcherTimer = setTimeout(() => {
    queuedWatcherTimer = null;
    if (!queuedWatcherError) return;
    lastWatcherErrorAt = Date.now();
    sendWatcherError({ message: queuedWatcherError });
    queuedWatcherError = null;
  }, remaining);
}

function createWatcher() {
  return createDrawingsWatcher(
    {
      onChange: broadcastFilesChanged,
      onRootInvalid: async (_reason, revision) => {
        const info = await getDrawings();
        broadcastFilesChanged({
          entries: [],
          revision,
          root: null,
          info,
        });
      },
      onError: (error) => {
        broadcastWatcherError(error);
      },
    },
    {
      listEntries,
      getDrawings,
    },
  );
}

function ensureWatcher() {
  if (!watcher) watcher = createWatcher();
  return watcher;
}

async function pruneThumbnails() {
  try {
    const entries = await listEntries();
    await pruneThumbnailCache(new Set(entries.map((entry) => entry.id)));
  } catch (error) {
    log.error("[thumbnails] prune failed", error);
  }
}

function withWatchIgnore<TArgs extends unknown[], TRet>(
  mutator: (...args: [...TArgs, FsMutationHooks?]) => TRet,
) {
  return (...args: [...TArgs]): TRet => {
    const w = ensureWatcher();
    return mutator(...args, {
      beforeMutate: (paths) => w.ignorePaths(paths),
    });
  };
}

const surfacePrimaryUi = async () => {
  const existing = BrowserWindow.getAllWindows();
  if (existing.length > 0) {
    const win = existing[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  const info = await getDrawings();
  if (info.configured && info.path) {
    const w = ensureWatcher();
    void w.start(info.path);
    ensureMainWindow();
  } else {
    createGreetingWindow();
  }
};

const installPermissionHandlers = () => {
  const handlePermissionRequest = (
    webContents: Electron.WebContents,
    permission: string,
    callback: (granted: boolean) => void,
  ) => {
    if (!APP_ALLOWED_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }

    callback(isTrustedRendererUrl(webContents.getURL()));
  };

  const handlePermissionCheck = (webContents: Electron.WebContents | null, permission: string) => {
    if (!APP_ALLOWED_PERMISSIONS.has(permission)) return false;
    return webContents !== null && isTrustedRendererUrl(webContents.getURL());
  };

  for (const ses of [session.defaultSession, session.fromPartition(LIBRARY_PARTITION)]) {
    ses.setPermissionRequestHandler(handlePermissionRequest);
    ses.setPermissionCheckHandler(handlePermissionCheck);
  }
};

const installLibraryCsp = () => {
  session.fromPartition(LIBRARY_PARTITION).webRequest.onHeadersReceived((details, callback) => {
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      callback({});
      return;
    }

    if (url.protocol !== "https:" || url.host !== "libraries.excalidraw.com") {
      callback({});
      return;
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [LIBRARY_CSP],
      },
    });
  });
};

void app.whenReady().then(async () => {
  if (!gotTheLock) return;

  electronApp.setAppUserModelId("com.xdrawz");
  initLogger();
  installLibraryCsp();
  installPermissionHandlers();
  installAppProtocolHandler();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[])
        : []),
      ...(process.platform === "darwin"
        ? []
        : [{ label: "File", submenu: [{ role: "quit" }] as MenuItemConstructorOptions[] }]),
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "resetZoom", label: "Actual Size", accelerator: "Alt+0" },
          { role: "zoomIn", label: "Zoom In", accelerator: "Alt+=" },
          { role: "zoomOut", label: "Zoom Out", accelerator: "Alt+-" },
          ...(is.dev
            ? ([
                { type: "separator" },
                { role: "reload" },
                { role: "forceReload" },
                { role: "toggleDevTools" },
              ] as MenuItemConstructorOptions[])
            : []),
        ],
      },
      { role: "windowMenu" },
    ]),
  );

  applyTheme();
  nativeTheme.on("updated", applyWindowBgColor);

  app.on("browser-window-created", (_, win) => {
    optimizer.watchWindowShortcuts(win, { zoom: true });
  });

  registerIpcHandlers({
    getDrawings,
    loadDrawings: async () => {
      const info = await getDrawings();
      const entries = await listEntries();
      return {
        info,
        entries,
        prefs: {
          lastOpenedFileId: getLastOpenedFileId(),
        },
      };
    },
    listEntries,
    readDrawingFile,
    writeDrawingFile: withWatchIgnore(writeDrawingFile),
    renameEntry: withWatchIgnore(renameEntry),
    createEntry: withWatchIgnore(createEntry),
    deleteEntry: withWatchIgnore(
      (id: string, mode: Parameters<typeof deleteEntry>[1], hooks: FsMutationHooks | undefined) =>
        deleteEntry(id, mode, hooks, (trashPath) => shell.trashItem(trashPath)),
    ),
    writeDrawingFileRecover: withWatchIgnore(writeDrawingFileRecover),
    destroyWindow,
    markWindowReady,
    cancelQuit,
    onDirtyState,
    onFlushStarted,
    showUnsavedChangesDialog,
    getSettings,
    updateSettings: setSettings,
    getThumbnails: readThumbnailRecords,
    saveThumbnail: writeThumbnailRecord,
    pickDrawings: async (parentWindow) => {
      const info = await pickDrawings(parentWindow);
      if (info) {
        const w = ensureWatcher();
        if (info.configured && info.path) {
          if (w.getRoot() !== info.path) {
            await w.restart(info.path);
            void w.refreshNow();
          }
          void pruneThumbnails();
        } else {
          await w.stop();
        }

        const active = ensureMainWindow();
        if (parentWindow && parentWindow !== active && !parentWindow.isDestroyed()) {
          parentWindow.close();
        }
      }

      return info;
    },
  });

  const info = await getDrawings();

  if (info.configured && info.path) {
    const w = ensureWatcher();
    await w.start(info.path);
    void pruneThumbnails();
    ensureMainWindow();
  } else {
    createGreetingWindow();
  }

  app.on("second-instance", () => {
    void surfacePrimaryUi();
  });

  app.on("activate", () => {
    void surfacePrimaryUi();
  });
});

app.on("before-quit", (event) => {
  const win = getMainWindow();
  if (
    isQuittingNow() ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isCrashed() ||
    !isWindowReady(win)
  ) {
    void watcher?.stop();
    return;
  }

  event.preventDefault();
  requestQuitViaRenderer(win);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
