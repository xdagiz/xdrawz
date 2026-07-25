export type DrawingInfo = {
  path: string | null;
  displayName: string | null;
  configured: boolean;
  missing: boolean;
};

export type Prefs = {
  lastOpenedFileId: string | null;
};

export type DrawingsSnapshot = {
  info: DrawingInfo;
  entries: FileEntry[];
  prefs: Prefs;
};

export type FileEntry = {
  id: string;
  name: string;
  kind: "file" | "directory";
  parentId: string | null;
  modifiedAt: number;
  size: number;
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

export const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;

export type UnsavedReason = "quit" | "switch";
export type UnsavedChoice = "save" | "discard" | "cancel";
export type FileRecoverChoice = "recover" | "discard" | "cancel";
export type FileChangedChoice = "reload" | "overwrite" | "cancel";

export const FILE_NOT_FOUND_MESSAGE = "File not found";

export type StoreType = {
  drawingsPath?: string;
  lastOpenedFileId?: string | null;
};

export type FilesChangedEvent = {
  entries: FileEntry[];
  revision: number;
  root: string | null;
  info?: DrawingInfo;
};

export type ExternalConflict =
  | { type: "missing"; fileId: string }
  | { type: "changed"; fileId: string; diskModifiedAt: number }
  | null;

export type StoreKey = keyof StoreType;
