import { PING } from "@shared/channels";
import { ipcMain } from "electron";

export const registerIpcHandlers = () => {
  ipcMain.on(PING, async (_event) => console.log("pong"));
};
