import { DEFAULT_THEME, THEME_PREFERENCES } from "@shared/ipc";
import type { AppSettings, SettingsUpdate } from "@shared/ipc";
import { BrowserWindow, nativeTheme } from "electron";

import { store } from "./store";

export const getSettings = (): AppSettings => ({
  theme: store.get("theme") ?? DEFAULT_THEME,
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
  const next = getSettings();
  if (update.theme !== undefined) {
    if (!THEME_PREFERENCES.includes(update.theme)) {
      throw new Error(`Invalid theme preference: ${update.theme}`);
    }
    next.theme = update.theme;
    store.set("theme", update.theme);
  }

  applyTheme();
  return next;
};
