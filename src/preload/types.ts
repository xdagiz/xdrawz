import type { DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";

export interface NativeApi {
  drawings: {
    get: () => Promise<DrawingInfo>;
    load: () => Promise<DrawingsSnapshot>;
    pick: () => Promise<DrawingInfo | null>;
  };
  files: {
    list: () => Promise<FileEntry[]>;
    read: (id: string) => Promise<string>;
  };
}
