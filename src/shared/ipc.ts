import { errorWithCode } from "@shared/errors";

export const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;
export const FILE_NOT_FOUND_MESSAGE = "File not found";

export const FILE_DELETE_MODES = ["trash", "permanent"] as const;
export type FileDeleteMode = (typeof FILE_DELETE_MODES)[number];

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

export const DEFAULT_THEME: ThemePreference = "system";

export const isThemePreference = (value: unknown): value is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === value);

export type SaveOrigin = "auto" | "explicit";

export type DrawingInfo = {
  path: string | null;
  displayName: string | null;
  configured: boolean;
  missing: boolean;
};

export type Prefs = {
  lastOpenedFileId: string | null;
};

export const isAncestorId = (ancestorId: string, id: string): boolean =>
  id !== ancestorId && id.startsWith(`${ancestorId}/`);

export type FileEntry = {
  id: string;
  name: string;
  kind: "file" | "directory";
  parentId: string | null;
  modifiedAt: number;
  size: number;
};

export const parentIdOf = (id: string): string | null => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
};

export type DrawingsSnapshot = {
  info: DrawingInfo;
  entries: FileEntry[];
  prefs: Prefs;
};

export type ContextMenuItem = {
  id: string;
  label: string;
};

export type ContextMenuRequest = {
  items: ContextMenuItem[];
  x: number;
  y: number;
};

export type UnsavedReason = "quit" | "switch";
export type UnsavedChoice = "save" | "discard" | "cancel";
export type FileRecoverChoice = "recover" | "discard" | "cancel";
export type FileChangedChoice = "reload" | "overwrite" | "cancel";
export type WindowCloseRequest = {
  requestId: number;
  kind: "check" | "flush";
};

export type StoreType = {
  drawingsPath?: string;
  lastOpenedFileId?: string | null;
  recentFileIds?: string[] | null;
  theme?: ThemePreference;
  zoomLevel?: number;
  autosaveIntervalMs?: number;
  reopenLastDrawing?: boolean;
};

export type StoreKey = keyof StoreType;

export type FilesChangedEvent = {
  entries: FileEntry[];
  revision: number;
  root: string | null;
  info?: DrawingInfo;
};

export type WatcherErrorEvent = {
  message: string;
};

export type ExternalConflict =
  | { type: "missing"; fileId: string }
  | { type: "changed"; fileId: string; diskModifiedAt: number }
  | null;

export const AUTOSAVE_PRESETS_MS = [1_000, 5_000, 15_000, 30_000] as const;

export type AutosavePresetMs = (typeof AUTOSAVE_PRESETS_MS)[number];

export const DEFAULT_AUTOSAVE_INTERVAL_MS: AutosavePresetMs = 5_000;

export const isAutosavePresetMs = (value: number): value is AutosavePresetMs =>
  AUTOSAVE_PRESETS_MS.some((preset) => preset === value);

export type AppSettings = {
  theme: ThemePreference;
  autosaveIntervalMs: number;
  reopenLastDrawing: boolean;
};

export type SettingsUpdate = Partial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: DEFAULT_THEME,
  autosaveIntervalMs: DEFAULT_AUTOSAVE_INTERVAL_MS,
  reopenLastDrawing: true,
};

export const validateSettingsUpdate = (payload: Record<string, unknown>): SettingsUpdate => {
  const update: SettingsUpdate = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    switch (key) {
      case "theme": {
        if (!isThemePreference(value)) {
          throw errorWithCode(`Invalid theme preference: ${JSON.stringify(value)}`, "INVALID");
        }
        update.theme = value;
        break;
      }
      case "autosaveIntervalMs": {
        if (typeof value !== "number" || !Number.isInteger(value) || !isAutosavePresetMs(value)) {
          throw errorWithCode(`Invalid autosave interval: ${JSON.stringify(value)}`, "INVALID");
        }
        update.autosaveIntervalMs = value;
        break;
      }
      case "reopenLastDrawing":
        if (typeof value !== "boolean") {
          throw errorWithCode(`${key} must be a boolean`, "INVALID");
        }
        update[key] = value;
        break;
      default:
        throw errorWithCode(`Unknown setting: ${key}`, "INVALID");
    }
  }
  return update;
};

export type ThumbnailRecord = {
  fileId: string;
  mtimeMs: number;
  size: number;
  light: string;
  dark: string;
};
