import { NativeApi } from "./types";

declare global {
  interface Window {
    api: NativeApi;
  }
}
