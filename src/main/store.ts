import { StoreType } from "@shared/ipc";
import Store from "electron-store";

export const store = new Store<StoreType>({
  name: "settings",
  defaults: {
    drawingsPath: undefined,
  },
});

export const getDrawingPath = () => nonEmptyString(store.get("drawingsPath"));

export const setDrawingPath = (newPath: string) => store.set("drawingsPath", newPath);

export const getLastOpenedFileId = () => nonEmptyString(store.get("lastOpenedFileId"));

const nonEmptyString = (val: unknown): string | null =>
  typeof val === "string" && val.length > 0 ? val : null;
