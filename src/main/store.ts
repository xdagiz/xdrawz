import { DEFAULT_THEME, StoreType } from "@shared/ipc";
import Store from "electron-store";

export const store = new Store<StoreType>({
  name: "settings",
  schema: {
    drawingsPath: {
      type: ["string", "null"],
    },
    lastOpenedFileId: {
      type: ["string", "null"],
    },
    theme: {
      type: "string",
      enum: ["light", "dark", "system"],
      default: DEFAULT_THEME,
    },
    zoomLevel: {
      type: "number",
      default: 0,
    },
  },
});

export const getDrawingPath = () => nonEmptyString(store.get("drawingsPath"));

export const setDrawingPath = (newPath: string) => store.set("drawingsPath", newPath);

export const getLastOpenedFileId = () => nonEmptyString(store.get("lastOpenedFileId"));

export const getZoomLevel = () => store.get("zoomLevel") ?? 0;

export const setZoomLevel = (newLevel: number) => store.set("zoomLevel", newLevel);

const nonEmptyString = (val: unknown): string | null =>
  typeof val === "string" && val.length > 0 ? val : null;
