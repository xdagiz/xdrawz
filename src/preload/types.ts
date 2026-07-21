import type { DrawingInfo } from "@shared/ipc";

export interface NativeApi {
  drawings: {
    get: () => Promise<DrawingInfo>;
    pick: () => Promise<DrawingInfo | null>;
  };
}
