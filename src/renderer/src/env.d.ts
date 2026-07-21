/// <reference types="vite/client" />

import type { NativeApi } from "../../preload/types";

declare global {
  interface Window {
    api: NativeApi;
  }
}
