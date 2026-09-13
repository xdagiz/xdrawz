import { codedError } from "./errors";
import type { RendererSafeError } from "./errors";

export const FILE_NOT_FOUND_MESSAGE = "File not found";

export type RendererStoreKey = "lastOpenedFileId" | "libraryItems";

export type ContextMenuRequest = {
  items: { id: string; label: string }[];
  x: number;
  y: number;
};

export type ChannelMap = {
  "drawings:get": { args: []; result: DrawingInfo; operation: "load" };
  "drawings:load": { args: []; result: DrawingsSnapshot; operation: "load" };
  "drawings:pick": { args: []; result: DrawingInfo | null; operation: "load" };
  "files:list": { args: []; result: FileEntry[]; operation: "read" };
  "files:read": { args: [id: string]; result: string; operation: "read" };
  "files:write": { args: [id: string, content: string]; result: FileEntry; operation: "save" };
  "files:write-recover": {
    args: [id: string, content: string];
    result: FileEntry;
    operation: "recover";
  };
  "files:rename": { args: [id: string, newName: string]; result: FileEntry; operation: "rename" };
  "files:create": {
    args: [parentId: string | null, name: string, kind: "file" | "directory"];
    result: FileEntry;
    operation: "create";
  };
  "files:delete": { args: [id: string, mode?: FileDeleteMode]; result: void; operation: "delete" };
  "store:get": { args: [key: RendererStoreKey]; result: string | null; operation: "unexpected" };
  "store:set": {
    args: [key: RendererStoreKey, value: string | null];
    result: void;
    operation: "unexpected";
  };
  "store:delete": { args: [key: RendererStoreKey]; result: void; operation: "unexpected" };
  "settings:get": { args: []; result: AppSettings; operation: "settings" };
  "settings:set": { args: [update: SettingsUpdate]; result: AppSettings; operation: "settings" };
  "thumbnails:get": { args: [ids: string[]]; result: ThumbnailRecord[]; operation: "read" };
  "thumbnails:put": { args: [record: ThumbnailRecord]; result: void; operation: "save" };
  "context-menu:show": {
    args: [request: ContextMenuRequest];
    result: string | null;
    operation: "unexpected";
  };
  "dialog:unsaved-changes": {
    args: [reason?: UnsavedReason];
    result: UnsavedChoice;
    operation: "unexpected";
  };
  "dialog:file-recover": {
    args: [fileName: string];
    result: "recover" | "discard" | "cancel";
    operation: "unexpected";
  };
  "dialog:file-changed": {
    args: [fileName: string];
    result: "reload" | "overwrite" | "cancel";
    operation: "unexpected";
  };
  "app:quit": { args: []; result: void; operation: "unexpected" };
  "window:close": { args: [requestId: number]; result: void; operation: "unexpected" };
  "window:report-fatal": {
    args: [payload: RendererSafeError];
    result: void;
    operation: "unexpected";
  };
};

export type ChannelName = keyof ChannelMap;

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

export const parentIdOf = (id: string) => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
};

const entryCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export const compareEntryIds = (a: string, b: string) =>
  entryCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const sortFileEntries = (entries: FileEntry[]): FileEntry[] =>
  entries.toSorted((a, b) => compareEntryIds(a.id, b.id));

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
  libraryItems?: string | null;
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

export const MAX_THUMBNAIL_BATCH = 500;
export const MAX_DRAWING_CONTENT_BYTES = 10 * 1024 * 1024;

export const validateDrawingRecord = (record: unknown): void => {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw codedError("Drawing must be a JSON object", {
      code: "INVALID",
      reason: "invalid-record",
    });
  }
  if ("elements" in record && !Array.isArray(record.elements)) {
    throw codedError("Drawing elements must be an array when present", {
      code: "INVALID",
      reason: "invalid-record",
      field: "elements",
    });
  }
  if (
    "files" in record &&
    (record.files === null || typeof record.files !== "object" || Array.isArray(record.files))
  ) {
    throw codedError("Drawing files must be an object when present", {
      code: "INVALID",
      reason: "invalid-record",
      field: "files",
    });
  }
};

export type LibraryReturnedEvent = {
  hash: string;
};
