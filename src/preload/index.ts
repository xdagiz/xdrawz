import { PING } from "@shared/channels";
import { contextBridge, ipcRenderer } from "electron";

import { NativeApi } from "./types";

const api: NativeApi = {
  ping: () => ipcRenderer.send(PING),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api;
}
