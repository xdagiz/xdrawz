for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    process.emitWarning(`stdio stream error: ${error.message}`);
  });
}

import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { FILES_CHANGED, WATCHER_ERROR } from "@shared/channels";
import type { FilesChangedEvent, WatcherErrorEvent } from "@shared/ipc";
import {
  app,
  dialog,
  shell,
  nativeTheme,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

import icon from "../../assets/icon.png?asset";
import {
  destroyWindow,
  installCloseGuard,
  isQuittingNow,
  isWindowReady,
  cancelQuit,
  markWindowReady,
  onDirtyState,
  onFlushStarted,
  requestQuitViaRenderer,
} from "./close-guard";
import { getDrawings, pickDrawings } from "./drawings";
import { shouldQuitAfterFatal } from "./errors";
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
  APP_GREETING_URL,
  APP_INDEX_URL,
  installAppProtocolHandler,
  isTrustedRendererUrl,
  registerAppScheme,
  registerIpcHandlers,
} from "./ipc";
import { initLogger, log } from "./logger";
import {
  applyTheme,
  getSettings,
  setSettings,
  windowBgColor,
  applyWindowBgColor,
} from "./settings";
import { getLastOpenedFileId } from "./store";
import { pruneThumbnailCache, readThumbnailRecords, writeThumbnailRecord } from "./thumbnails";
import { createDrawingsWatcher, type DrawingsWatcher } from "./watcher";

process.on("uncaughtException", (error) => {
  log.error("[main:uncaughtException]", error);
  dialog.showErrorBox("xdrawz crashed", error instanceof Error ? error.message : String(error));
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("[main:unhandledRejection]", reason);
});

app.on("render-process-gone", (_event, _contents, details) => {
  if (details.reason === "clean-exit") return;
  log.error("[render-process-gone]", details);
  const shouldQuit = shouldQuitAfterFatal(Date.now());
  if (shouldQuit) {
    void dialog
      .showMessageBox({
        type: "error",
        buttons: ["Quit", "Continue"],
        defaultId: 0,
        cancelId: 1,
        message: "xdrawz renderer crashed",
        detail: `${details.reason} (${details.exitCode})`,
      })
      .then(({ response }) => {
        if (response === 0) app.quit();
      });
  }
});

app.on("child-process-gone", (_event, details) => {
  log.error("[child-process-gone]", details);
});

let mainWindow: BrowserWindow | null = null;
let watcher: DrawingsWatcher | null = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

registerAppScheme();

function broadcastFilesChanged(event: FilesChangedEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    win.webContents.send(FILES_CHANGED, event);
  }
}

const WATCHER_ERROR_INTERVAL_MS = 10_000;
let lastWatcherErrorAt = 0;
let queuedWatcherError: string | null = null;
let queuedWatcherTimer: NodeJS.Timeout | null = null;

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

function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  return mainWindow;
}

// https://github.com/electron/electron/issues/48859
function showWhenReady(win: BrowserWindow) {
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  win.once("ready-to-show", show);
  win.webContents.once("did-finish-load", show);
}

const isSafeExternalUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

function wireNavigationPolicy(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = isSafeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    const external = isSafeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
}

const baseWebPreferences = () => ({
  preload: join(import.meta.dirname, "../preload/index.cjs"),
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
});

function wireRendererDiagnostics(win: BrowserWindow) {
  win.webContents.on("preload-error", (_event, preloadPath, error) =>
    log.error("Preload failed:", preloadPath, error),
  );

  win.webContents.on("unresponsive", () => {
    log.warn("[webContents] unresponsive", win.id);
  });
}

function loadRendererPage(win: BrowserWindow, devPath: string, prodUrl: string) {
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"].replace(/\/$/, "");
    void win.loadURL(devPath ? `${base}/${devPath}` : base);
    return;
  }

  void win.loadURL(prodUrl);
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: baseWebPreferences(),
  });

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false);
  }

  showWhenReady(win);
  installCloseGuard(win);
  wireNavigationPolicy(win);
  wireRendererDiagnostics(win);
  loadRendererPage(win, "", APP_INDEX_URL);

  return win;
}

function createGreetingWindow() {
  const greetingWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { type: "splash" } : {}),
    webPreferences: baseWebPreferences(),
  });

  showWhenReady(greetingWindow);
  wireNavigationPolicy(greetingWindow);
  wireRendererDiagnostics(greetingWindow);
  loadRendererPage(greetingWindow, "greeting.html", APP_GREETING_URL);

  return greetingWindow;
}

const surfacePrimaryUi = async (): Promise<void> => {
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

void app.whenReady().then(async () => {
  if (!gotTheLock) return;

  electronApp.setAppUserModelId("com.xdrawz");
  initLogger();
  installAppProtocolHandler();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[])
        : []),
      { role: "fileMenu" },
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

  const writeDrawingFileWatched = withWatchIgnore(writeDrawingFile);
  const writeDrawingFileRecoverWatched = withWatchIgnore(writeDrawingFileRecover);
  const renameEntryWatched = withWatchIgnore(renameEntry);
  const createEntryWatched = withWatchIgnore(createEntry);
  const deleteEntryWatched = withWatchIgnore(
    (id: string, mode: Parameters<typeof deleteEntry>[1], hooks: FsMutationHooks | undefined) =>
      deleteEntry(id, mode, hooks, (trashPath) => shell.trashItem(trashPath)),
  );

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
    writeDrawingFile: writeDrawingFileWatched,
    renameEntry: renameEntryWatched,
    createEntry: createEntryWatched,
    deleteEntry: deleteEntryWatched,
    writeDrawingFileRecover: writeDrawingFileRecoverWatched,
    destroyWindow,
    markWindowReady,
    cancelQuit,
    onDirtyState,
    onFlushStarted,
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

        ensureMainWindow();
        if (parentWindow && parentWindow !== mainWindow && !parentWindow.isDestroyed()) {
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
  if (
    isQuittingNow() ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isCrashed() ||
    !isWindowReady(mainWindow)
  ) {
    void watcher?.stop();
    return;
  }

  event.preventDefault();
  requestQuitViaRenderer(mainWindow);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
