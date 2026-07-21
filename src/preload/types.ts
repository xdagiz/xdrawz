import type { ContextMenuItem, DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";

export interface NativeApi {
  drawings: {
    get: () => Promise<DrawingInfo>;
    load: () => Promise<DrawingsSnapshot>;
    pick: () => Promise<DrawingInfo | null>;
  };
  files: {
    list: () => Promise<FileEntry[]>;
    read: (id: string) => Promise<string>;
    rename: (id: string, newName: string) => Promise<FileEntry>;
    delete: (id: string) => Promise<void>;
  };
  contextMenu: {
    show: (items: ContextMenuItem[], x: number, y: number) => Promise<string | null>;
  };
}
