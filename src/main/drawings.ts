import { stat } from "node:fs/promises";
import { resolve, basename } from "node:path";

import { DrawingInfo } from "@shared/ipc";
import { app, dialog, type BrowserWindow } from "electron";

import { getDrawingPath, setDrawingPath } from "./store";

export const getDrawings = async (): Promise<DrawingInfo> => {
  const storedPath = getDrawingPath();
  if (!storedPath) {
    return {
      path: null,
      displayName: null,
      configured: false,
      missing: false,
    };
  }

  const resolved = resolve(storedPath);
  const def: DrawingInfo = {
    path: resolved,
    displayName: basename(resolved),
    configured: false,
    missing: true,
  };

  try {
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return def;
    }

    return {
      path: resolved,
      displayName: basename(resolved),
      configured: true,
      missing: false,
    };
  } catch {
    return def;
  }
};

export const pickDrawings = async (win: BrowserWindow | null): Promise<DrawingInfo | null> => {
  const opts: Electron.OpenDialogOptions = {
    title: "Choose your drawings folder",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: app.getPath("documents"),
  };

  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const chosen = resolve(result.filePaths[0]);
  const stats = await stat(chosen).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Not a directory: ${chosen}`);
  }

  setDrawingPath(chosen);

  return getDrawings();
};
