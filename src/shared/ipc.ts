export const FILE_NOT_FOUND_MESSAGE = "File not found";

export const FILE_DELETE_MODES = ["trash", "permanent"] as const;
export type FileDeleteMode = (typeof FILE_DELETE_MODES)[number];

export type ThemePreference = "light" | "dark" | "system";

export const DEFAULT_THEME: ThemePreference = "system";

export type DrawingInfo = {
  path: string | null;
  displayName: string | null;
  configured: boolean;
  missing: boolean;
};

export type Prefs = {
  lastOpenedFileId: string | null;
};

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

export type UnsavedReason = "quit" | "switch";
export type UnsavedChoice = "save" | "discard" | "cancel";
export type WindowCloseRequest = {
  requestId: number;
  kind: "check" | "flush";
};

export type StoreType = {
  drawingsPath?: string;
  lastOpenedFileId?: string | null;
  recentFileIds?: string | null;
  theme?: ThemePreference;
  autosaveIntervalMs?: number;
  reopenLastDrawing?: boolean;
};

export type FilesChangedEvent = {
  entries: FileEntry[];
  revision: number;
  root: string | null;
  info?: DrawingInfo;
};

export type WatcherErrorEvent = {
  message: string;
};

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

export type ThumbnailRecord = {
  fileId: string;
  mtimeMs: number;
  size: number;
  light: string;
  dark: string;
};
