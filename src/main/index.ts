import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { FILES_CHANGED } from "@shared/channels";
import type { FilesChangedEvent } from "@shared/ipc";
import { app, shell, nativeTheme, BrowserWindow, Menu } from "electron";

import icon from "../../resources/icon.png?asset";
import { destroyWindow, installCloseGuard } from "./close-guard";
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
import { registerIpcHandlers } from "./ipc";
import {
  applyTheme,
  getSettings,
  setSettings,
  windowBgColor,
  applyWindowBgColor,
} from "./settings";
import { getLastOpenedFileId } from "./store";
import { createDrawingsWatcher, type DrawingsWatcher } from "./watcher";

let mainWindow: BrowserWindow | null = null;
let watcher: DrawingsWatcher | null = null;

function broadcastFilesChanged(event: FilesChangedEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) continue;
    win.webContents.send(FILES_CHANGED, event);
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
        console.error("[watcher]", error);
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

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: windowBgColor(),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
    },
  });

  showWhenReady(mainWindow);
  installCloseGuard(mainWindow);

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) =>
    console.error("Preload failed:", preloadPath, error),
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  greetingWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  showWhenReady(greetingWindow);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    greetingWindow.loadURL(
      process.env["ELECTRON_RENDERER_URL"].replace(/\/$/, "") + "/greeting.html",
    );
  } else {
    greetingWindow.loadFile(join(__dirname, "../renderer/greeting.html"));
  }

  return greetingWindow;
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.xdrawz");

  applyTheme();
  nativeTheme.on("updated", applyWindowBgColor);

  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

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

app.on("before-quit", () => {
  void watcher?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
