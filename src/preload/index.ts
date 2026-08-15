import {
  CONTEXT_MENU_SHOW,
  DIALOG_FILE_CHANGED,
  DIALOG_FILE_RECOVER,
  DIALOG_UNSAVED_CHANGES,
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_CHANGED,
  FILES_DELETE,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_WRITE,
  FILES_WRITE_RECOVER,
  SETTINGS_GET,
  SETTINGS_SET,
  STORE_CLEAR,
  STORE_DELETE,
  STORE_GET,
  STORE_SET,
  WATCHER_ERROR,
  WINDOW_CANCEL_QUIT,
  WINDOW_CLOSE,
  WINDOW_CLOSE_CANCELLED,
  WINDOW_DIRTY_STATE,
  WINDOW_FLUSH_STARTED,
  WINDOW_READY,
  WINDOW_WILL_CLOSE,
} from "@shared/channels";
import type { FilesChangedEvent, WatcherErrorEvent, WindowCloseRequest } from "@shared/ipc";
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
    writeRecover: (id, content) => ipcRenderer.invoke(FILES_WRITE_RECOVER, id, content),
    rename: (id, newName) => ipcRenderer.invoke(FILES_RENAME, id, newName),
    delete: (id) => ipcRenderer.invoke(FILES_DELETE, id),
    onChanged: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FilesChangedEvent) => {
        cb(payload);
      };
      ipcRenderer.on(FILES_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(FILES_CHANGED, listener);
      };
    },
    onWatcherError: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WatcherErrorEvent) => {
        cb(payload);
      };
      ipcRenderer.on(WATCHER_ERROR, listener);
      return () => {
        ipcRenderer.removeListener(WATCHER_ERROR, listener);
      };
    },
  },
  store: {
    get: (key) => ipcRenderer.invoke(STORE_GET, key),
    set: (key, value) => ipcRenderer.invoke(STORE_SET, key, value),
    delete: (key) => ipcRenderer.invoke(STORE_DELETE, key),
    clear: () => ipcRenderer.invoke(STORE_CLEAR),
  },
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_GET),
    update: (updates) => ipcRenderer.invoke(SETTINGS_SET, updates),
  },
  contextMenu: {
    show: (items, x, y) => ipcRenderer.invoke(CONTEXT_MENU_SHOW, { items, x, y }),
  },
  dialog: {
    unsavedChanges: (reason) => ipcRenderer.invoke(DIALOG_UNSAVED_CHANGES, reason),
    fileRecover: (fileName) => ipcRenderer.invoke(DIALOG_FILE_RECOVER, fileName),
    fileChanged: (fileName) => ipcRenderer.invoke(DIALOG_FILE_CHANGED, fileName),
  },
  window: {
    onWillClose: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, request: WindowCloseRequest) =>
        cb(request);
      ipcRenderer.on(WINDOW_WILL_CLOSE, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_WILL_CLOSE, listener);
      };
    },
    onCloseCancelled: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(WINDOW_CLOSE_CANCELLED, listener);
      return () => {
        ipcRenderer.removeListener(WINDOW_CLOSE_CANCELLED, listener);
      };
    },
    ready: () => ipcRenderer.send(WINDOW_READY),
    close: (requestId: number) => ipcRenderer.invoke(WINDOW_CLOSE, requestId),
    cancelQuit: (requestId: number) => ipcRenderer.send(WINDOW_CANCEL_QUIT, requestId),
    reportDirtyState: (requestId: number, dirty: boolean) =>
      ipcRenderer.send(WINDOW_DIRTY_STATE, requestId, dirty),
    flushStarted: (requestId: number) => ipcRenderer.send(WINDOW_FLUSH_STARTED, requestId),
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
