import {
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_LIST,
  FILES_READ,
} from "@shared/channels";
import { contextBridge, ipcRenderer } from "electron";

import { NativeApi } from "./types";

const api: NativeApi = {
  drawings: {
    get: () => ipcRenderer.invoke(DRAWINGS_GET),
    load: () => ipcRenderer.invoke(DRAWINGS_LOAD),
    pick: () => ipcRenderer.invoke(DRAWINGS_PICK),
  },
  files: {
    list: () => ipcRenderer.invoke(FILES_LIST),
    read: (id) => ipcRenderer.invoke(FILES_READ, id),
  },
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
