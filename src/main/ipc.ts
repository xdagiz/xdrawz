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
} from "@shared/channels";
import type {
  ContextMenuRequest,
  DrawingInfo,
  DrawingsSnapshot,
  FileEntry,
  UnsavedChoice,
  UnsavedReason,
} from "@shared/ipc";
import { BrowserWindow, dialog, ipcMain, Menu } from "electron";

type Deps = {
  getDrawings: () => Promise<DrawingInfo>;
  loadDrawings: () => Promise<DrawingsSnapshot>;
  listEntries: () => Promise<FileEntry[]>;
  pickDrawings: (parentWindow: BrowserWindow | null) => Promise<DrawingInfo | null>;
  readSceneFile: (id: string) => Promise<string>;
  writeSceneFile: (id: string, content: string) => Promise<void>;
  renameEntry: (id: string, newName: string) => Promise<FileEntry>;
  deleteEntry: (id: string) => Promise<void>;
  destroyWindow: (win: BrowserWindow) => void;
};

const windowFromEvent = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
};

const confirmUnsavedChanges = async (
  win: BrowserWindow | null,
  reason: UnsavedReason = "quit",
): Promise<UnsavedChoice> => {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: "You have unsaved changes.",
    detail:
      reason === "switch"
        ? "Do you want to save before leaving this drawing?"
        : "Do you want to save before quitting?",
  };

  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (response === 0) return "save";
  if (response === 1) return "discard";
  return "cancel";
};

export const registerIpcHandlers = (deps: Deps): void => {
  ipcMain.handle(DRAWINGS_GET, () => deps.getDrawings());
  ipcMain.handle(DRAWINGS_LOAD, () => deps.loadDrawings());

  ipcMain.handle(FILES_LIST, () => deps.listEntries());
  ipcMain.handle(FILES_READ, (_event, id: string) => deps.readSceneFile(id));
  ipcMain.handle(FILES_RENAME, (_event, id: string, newName: string) =>
    deps.renameEntry(id, newName),
  );
  ipcMain.handle(FILES_WRITE, (_event, id: string, content: string) =>
    deps.writeSceneFile(id, content),
  );
  ipcMain.handle(FILES_DELETE, (_event, id: string) => deps.deleteEntry(id));

  ipcMain.handle(DRAWINGS_PICK, (event) => deps.pickDrawings(windowFromEvent(event)));

  ipcMain.handle(CONTEXT_MENU_SHOW, (event, request: ContextMenuRequest) => {
    const win = windowFromEvent(event);
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

  ipcMain.handle(WINDOW_CLOSE, (event) => {
    const win = windowFromEvent(event);
    if (!win) return;
    deps.destroyWindow(win);
  });

  ipcMain.handle(DIALOG_UNSAVED_CHANGES, (event, reason?: UnsavedReason) =>
    confirmUnsavedChanges(windowFromEvent(event), reason),
  );
};
