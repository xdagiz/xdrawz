import {
  AUTOSAVE_PRESETS_MS,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  DEFAULT_THEME,
  StoreType,
} from "@shared/ipc";
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
    autosaveIntervalMs: {
      type: "number",
      enum: [...AUTOSAVE_PRESETS_MS],
      default: DEFAULT_AUTOSAVE_INTERVAL_MS,
    },
    reopenLastDrawing: {
      type: "boolean",
      default: true,
    },
  },
});

export const getDrawingPath = () => nonEmptyString(store.get("drawingsPath"));

export const setDrawingPath = (newPath: string) => store.set("drawingsPath", newPath);

export const getLastOpenedFileId = () => nonEmptyString(store.get("lastOpenedFileId"));

const nonEmptyString = (val: unknown) => (typeof val === "string" && val.length > 0 ? val : null);
