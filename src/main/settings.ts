import { DEFAULT_SETTINGS, validateSettingsUpdate } from "@shared/ipc";
import type { AppSettings, SettingsUpdate } from "@shared/ipc";
import { BrowserWindow, nativeTheme } from "electron";

import { store } from "./store";

export const getSettings = (): AppSettings => ({
  theme: store.get("theme") ?? DEFAULT_SETTINGS.theme,
  autosaveIntervalMs: store.get("autosaveIntervalMs") ?? DEFAULT_SETTINGS.autosaveIntervalMs,
  reopenLastDrawing: store.get("reopenLastDrawing") ?? DEFAULT_SETTINGS.reopenLastDrawing,
});

export const windowBgColor = () => (nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff");

export const applyWindowBgColor = () => {
  const backgroundColor = windowBgColor();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.setBackgroundColor(backgroundColor);
  }
};

export const applyTheme = () => {
  nativeTheme.themeSource = getSettings().theme;
  applyWindowBgColor();
};

export const setSettings = (update: SettingsUpdate): AppSettings => {
  const clean = validateSettingsUpdate(update);
  const next = getSettings();
  let themeChanged = false;

  if (clean.theme !== undefined) {
    next.theme = clean.theme;
    store.set("theme", clean.theme);
    themeChanged = true;
  }
  if (clean.autosaveIntervalMs !== undefined) {
    next.autosaveIntervalMs = clean.autosaveIntervalMs;
    store.set("autosaveIntervalMs", clean.autosaveIntervalMs);
  }
  if (clean.reopenLastDrawing !== undefined) {
    next.reopenLastDrawing = clean.reopenLastDrawing;
    store.set("reopenLastDrawing", clean.reopenLastDrawing);
  }

  if (themeChanged) applyTheme();
  return next;
};
