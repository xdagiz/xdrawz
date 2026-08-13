import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { FILES_CHANGED, WATCHER_ERROR } from "@shared/channels";
import type { FilesChangedEvent, WatcherErrorEvent } from "@shared/ipc";
import { app, shell, nativeTheme, BrowserWindow, Menu } from "electron";

import icon from "../../resources/icon.png?asset";
import {
  destroyWindow,
  installCloseGuard,
  isQuittingNow,
  isWindowReady,
  cancelQuit,
  markWindowReady,
  requestQuitViaRenderer,
} from "./close-guard";
import { getDrawings, pickDrawings } from "./drawings";
import {
  deleteEntry,
  listEntries,
  readSceneFile,
  renameEntry,
  writeSceneFile,
  writeSceneFileRecover,
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
import { getLastOpenedFileId, getZoomLevel, setZoomLevel } from "./store";
import { createDrawingsWatcher, type DrawingsWatcher } from "./watcher";

let mainWindow: BrowserWindow | null = null;
let watcher: DrawingsWatcher | null = null;

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

function broadcastWatcherError(error: unknown) {
  log.error("[watcher]", error);

  const now = Date.now();
  if (now - lastWatcherErrorAt < WATCHER_ERROR_INTERVAL_MS) return;
  lastWatcherErrorAt = now;

  const message = error instanceof Error ? error.message : String(error);
  const event: WatcherErrorEvent = { message };

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    win.webContents.send(WATCHER_ERROR, event);
  }
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

function withWatchIgnore<TArgs extends unknown[], TRet>(
  mutator: (...args: [...TArgs, FsMutationHooks?]) => TRet,
) {
  return (...args: [...TArgs]): TRet => {
    const w = ensureWatcher();
    return mutator(...args, {
      beforeMutate: (paths) => w.ignorePaths(paths),
    } as FsMutationHooks);
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

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  showWhenReady(mainWindow);
  installCloseGuard(mainWindow);
  wireNavigationPolicy(mainWindow);

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) =>
    log.error("Preload failed:", preloadPath, error),
  );

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadURL(APP_INDEX_URL);
  }

  return mainWindow;
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
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  showWhenReady(greetingWindow);
  wireNavigationPolicy(greetingWindow);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    greetingWindow.loadURL(
      process.env["ELECTRON_RENDERER_URL"].replace(/\/$/, "") + "/greeting.html",
    );
  } else {
    greetingWindow.loadURL(APP_GREETING_URL);
  }

  return greetingWindow;
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.xdrawz");
  initLogger();
  installAppProtocolHandler();

  applyTheme();
  nativeTheme.on("updated", applyWindowBgColor);

  app.on("browser-window-created", (_, win) => {
    optimizer.watchWindowShortcuts(win);

    const restoreZoom = () => {
      win.webContents.setZoomLevel(getZoomLevel());
    };

    win.webContents.on("did-finish-load", restoreZoom);
    win.webContents.on("did-navigate-in-page", restoreZoom);

    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (!(input.control || input.meta)) return;

      const zoomIn = input.code === "Equal" || input.code === "NumpadAdd";
      const zoomOut = input.code === "Minus" || input.code === "NumpadSubtract";
      const zoomReset = input.code === "Digit0" || input.code === "Numpad0";

      if (!zoomIn && !zoomOut && !zoomReset) return;
      event.preventDefault();

      const level = win.webContents.getZoomLevel();
      const next = zoomIn ? level + 0.5 : zoomOut ? level - 0.5 : 0;
      win.webContents.setZoomLevel(next);
      setZoomLevel(next);
    });
  });

  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  }

  const writeSceneFileWatched = withWatchIgnore(writeSceneFile);
  const writeSceneFileRecoverWatched = withWatchIgnore(writeSceneFileRecover);
  const renameEntryWatched = withWatchIgnore(renameEntry);
  const deleteEntryWatched = withWatchIgnore(deleteEntry);

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
    readSceneFile,
    writeSceneFile: writeSceneFileWatched,
    renameEntry: renameEntryWatched,
    deleteEntry: deleteEntryWatched,
    writeSceneFileRecover: writeSceneFileRecoverWatched,
    destroyWindow,
    markWindowReady,
    cancelQuit,
    getSettings,
    updateSettings: setSettings,
    pickDrawings: async (parentWindow) => {
      const info = await pickDrawings(parentWindow);
      if (info) {
        const w = ensureWatcher();
        if (info.configured && info.path) {
          await w.restart(info.path);
          void w.refreshNow();
        } else {
          await w.stop();
        }

        ensureMainWindow();
        if (parentWindow && !parentWindow.isDestroyed()) parentWindow.close();
      }
      return info;
    },
  });

  const info = await getDrawings();

  if (info.configured && info.path) {
    const w = ensureWatcher();
    await w.start(info.path);
    ensureMainWindow();
  } else {
    createGreetingWindow();
  }

  app.on("activate", () => {
    const existing = BrowserWindow.getAllWindows();
    if (existing.length > 0) {
      const win = existing[0];
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }

    getDrawings().then((i) => {
      if (i.configured && i.path) {
        const w = ensureWatcher();
        void w.start(i.path);
        ensureMainWindow();
      } else {
        createGreetingWindow();
      }
    });
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
