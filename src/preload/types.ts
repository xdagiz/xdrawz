import type { SerializedAppError } from "@shared/errors";
import type {
  AppSettings,
  DrawingInfo,
  DrawingsSnapshot,
  FileDeleteMode,
  FileEntry,
  FilesChangedEvent,
  SettingsUpdate,
  StoreType,
  ThumbnailRecord,
  UnsavedChoice,
  UnsavedReason,
  WatcherErrorEvent,
  WindowCloseRequest,
} from "@shared/ipc";

export type ContextMenuItem = { id: string; label: string };
export type FileRecoverChoice = "recover" | "discard" | "cancel";
export type FileChangedChoice = "reload" | "overwrite" | "cancel";
export type StoreKey = keyof StoreType;

export interface NativeApi {
  drawings: {
    get: () => Promise<DrawingInfo>;
    load: () => Promise<DrawingsSnapshot>;
    pick: () => Promise<DrawingInfo | null>;
  };
  files: {
    list: () => Promise<FileEntry[]>;
    read: (id: string) => Promise<string>;
    write: (id: string, content: string) => Promise<FileEntry>;
    writeRecover: (id: string, content: string) => Promise<FileEntry>;
    rename: (id: string, newName: string) => Promise<FileEntry>;
    create: (
      parentId: string | null,
      name: string,
      kind: "file" | "directory",
    ) => Promise<FileEntry>;
    delete: (id: string, mode?: FileDeleteMode) => Promise<void>;
    onChanged: (cb: (event: FilesChangedEvent) => void) => () => void;
    onWatcherError: (cb: (event: WatcherErrorEvent) => void) => () => void;
  };
  store: {
    get: (key: StoreKey) => Promise<string | null>;
    set: (key: StoreKey, value: string | null) => Promise<void>;
    delete: (key: StoreKey) => Promise<void>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    update: (updated: SettingsUpdate) => Promise<AppSettings>;
  };
  thumbnails: {
    get: (ids: string[]) => Promise<ThumbnailRecord[]>;
    put: (record: ThumbnailRecord) => Promise<void>;
  };
  contextMenu: {
    show: (items: ContextMenuItem[], x: number, y: number) => Promise<string | null>;
  };
  dialog: {
    unsavedChanges: (reason?: UnsavedReason) => Promise<UnsavedChoice>;
    fileRecover: (fileName: string) => Promise<FileRecoverChoice>;
    fileChanged: (fileName: string) => Promise<FileChangedChoice>;
  };
  window: {
    onWillClose: (cb: (request: WindowCloseRequest) => void) => () => void;
    onCloseCancelled: (cb: () => void) => () => void;
    ready: () => void;
    close: (requestId: number) => Promise<void>;
    cancelQuit: (requestId: number) => void;
    reportDirtyState: (requestId: number, dirty: boolean, skipPrompt?: boolean) => void;
    flushStarted: (requestId: number) => void;
    reportFatal: (payload: SerializedAppError) => Promise<void>;
  };
}
