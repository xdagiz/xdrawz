import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { app, shell, BrowserWindow, Menu } from "electron";

import icon from "../../resources/icon.png?asset";
import { getDrawings, pickDrawings } from "./drawings";
import { listEntries, readSceneFile, renameEntry, deleteEntry } from "./files";
import { registerIpcHandlers } from "./ipc";
import { getPrefs } from "./store";

let mainWindow: BrowserWindow | null = null;

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
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
    },
  });

  showWhenReady(mainWindow);

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

  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  }

  registerIpcHandlers({
    getDrawings,
    loadDrawings: async () => {
      const info = await getDrawings();
      const entries = await listEntries();
      return {
        info,
        entries,
        prefs: getPrefs(),
      };
    },
    listEntries,
    readSceneFile,
    renameEntry,
    deleteEntry,
    pickDrawings: async (parentWindow) => {
      const info = await pickDrawings(parentWindow);
      if (info) {
        ensureMainWindow();
        if (parentWindow && !parentWindow.isDestroyed()) {
          parentWindow.close();
        }
      }
      return info;
    },
  });

  const info = await getDrawings();

  if (info.configured) {
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
      if (i.configured) ensureMainWindow();
      else createGreetingWindow();
    });
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
