import type {
  ContextMenuItem,
  DrawingInfo,
  DrawingsSnapshot,
  FileEntry,
  UnsavedChoice,
  UnsavedReason,
} from "@shared/ipc";

export interface NativeApi {
  drawings: {
    get: () => Promise<DrawingInfo>;
    load: () => Promise<DrawingsSnapshot>;
    pick: () => Promise<DrawingInfo | null>;
  };
  files: {
    list: () => Promise<FileEntry[]>;
    read: (id: string) => Promise<string>;
    write: (id: string, content: string) => Promise<void>;
    rename: (id: string, newName: string) => Promise<FileEntry>;
    delete: (id: string) => Promise<void>;
  };
  contextMenu: {
    show: (items: ContextMenuItem[], x: number, y: number) => Promise<string | null>;
  };
  dialog: {
    unsavedChanges: (reason?: UnsavedReason) => Promise<UnsavedChoice>;
  };
  window: {
    onWillClose: (cb: () => void) => () => void;
    close: () => Promise<void>;
  };
}
