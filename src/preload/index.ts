import {
  CONTEXT_MENU_SHOW,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_DELETE,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  WINDOW_CLOSE,
  WINDOW_WILL_CLOSE,
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
    write: (id, content) => ipcRenderer.invoke(FILES_WRITE, id, content),
    rename: (id, newName) => ipcRenderer.invoke(FILES_RENAME, id, newName),
    delete: (id) => ipcRenderer.invoke(FILES_DELETE, id),
  },
  contextMenu: {
    show: (items, x, y) => ipcRenderer.invoke(CONTEXT_MENU_SHOW, { items, x, y }),
  },
  dialog: {
    unsavedChanges: (reason) => ipcRenderer.invoke(DIALOG_UNSAVED_CHANGES, reason),
  },
  window: {
    onWillClose: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(WINDOW_WILL_CLOSE, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_WILL_CLOSE, listener);
      };
    },
    close: () => ipcRenderer.invoke(WINDOW_CLOSE),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error fallback when contextIsolation is disabled
  window.api = api;
}
