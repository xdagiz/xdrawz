import { join } from "path";

import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { PING } from "@shared/channels";
import { app, shell, ipcMain, BrowserWindow } from "electron";

import icon from "../../resources/icon.png?asset";

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    show: false,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.xdrawz");

  app.on("browser-window-created", (_, window) => optimizer.watchWindowShortcuts(window));

  ipcMain.on(PING, () => console.log("pong"));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
