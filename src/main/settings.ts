import { codedError } from "@shared/errors";
import { DEFAULT_SETTINGS, isAutosavePresetMs, type ThemePreference } from "@shared/ipc";
import type { AppSettings, SettingsUpdate } from "@shared/ipc";
import { BrowserWindow, nativeTheme } from "electron";

import { store } from "./store";

const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

const isThemePreference = (value: unknown): value is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === value);

export const validateSettingsUpdate = (payload: Record<string, unknown>): SettingsUpdate => {
  const update: SettingsUpdate = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    switch (key) {
      case "theme": {
        if (!isThemePreference(value)) {
          throw codedError(`Invalid theme preference: ${JSON.stringify(value)}`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: "theme",
          });
        }
        update.theme = value;
        break;
      }
      case "autosaveIntervalMs": {
        if (typeof value !== "number" || !Number.isInteger(value) || !isAutosavePresetMs(value)) {
          throw codedError(`Invalid autosave interval: ${JSON.stringify(value)}`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: "autosaveIntervalMs",
          });
        }
        update.autosaveIntervalMs = value;
        break;
      }
      case "reopenLastDrawing":
        if (typeof value !== "boolean") {
          throw codedError(`${key} must be a boolean`, {
            code: "INVALID",
            reason: "invalid-payload",
            field: key,
          });
        }
        update[key] = value;
        break;
      default:
        throw codedError(`Unknown setting: ${key}`, {
          code: "INVALID",
          reason: "invalid-payload",
          field: key,
        });
    }
  }
  return update;
};

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
