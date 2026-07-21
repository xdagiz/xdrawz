import {
  DRAWINGS_GET,
  DRAWINGS_LOAD,
  DRAWINGS_PICK,
  FILES_LIST,
  FILES_READ,
  FILES_RENAME,
  FILES_DELETE,
  CONTEXT_MENU_SHOW,
} from "@shared/channels";
import type { ContextMenuRequest, DrawingInfo, DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { BrowserWindow, ipcMain, Menu } from "electron";

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: () => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
  readSceneFile: (id: string) => Promise<string>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  deleteEntry: (id: string) => Promise<void>;
};

export const registerIpcHandlers = (deps: Deps): void => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());
  ipcMain.handle(DRAWINGS_LOAD, () => deps.loadDrawings());
  ipcMain.handle(FILES_LIST, () => deps.listEntries());
  ipcMain.handle(FILES_READ, (_event, id: string) => deps.readSceneFile(id));
  ipcMain.handle(FILES_RENAME, (_event, id: string, newName: string) =>
    deps.renameEntry(id, newName),
  );
  ipcMain.handle(FILES_DELETE, (_event, id: string) => deps.deleteEntry(id));

  ipcMain.handle(DRAWINGS_PICK, (event) =>
    deps.pickDrawings(BrowserWindow.fromWebContents(event.sender)),
  );

  ipcMain.handle(CONTEXT_MENU_SHOW, (event, request: ContextMenuRequest) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    return new Promise<string | null>((resolve) => {
      let resolved = false;

      const template = request.items.map((item) => ({
        label: item.label,
        enabled: true,
        click: () => {
          resolved = true;
          resolve(item.id);
        },
      }));

      const menu = Menu.buildFromTemplate(template);
      menu.popup({
        window: win,
        x: request.x,
        y: request.y,
        callback: () => {
          if (!resolved) resolve(null);
        },
      });
    });
  });
};
