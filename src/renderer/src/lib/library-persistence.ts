import type { LibraryPersistenceAdapter } from "@excalidraw/excalidraw/data/library";
import type { LibraryItems } from "@excalidraw/excalidraw/types";

export const LIBRARY_STORE_KEY = "libraryItems";

export type LibraryStorage = {
  get: () => Promise<string | null>;
  set: (value: string | null) => Promise<void>;
};

type LibraryItemLike = { elements: unknown };

const isLibraryItemLike = (value: unknown): value is LibraryItemLike =>
  typeof value === "object" &&
  value !== null &&
  "elements" in value &&
  Array.isArray(value.elements);

export const isLibraryItemsPayload = (value: unknown): value is LibraryItems =>
  Array.isArray(value) && value.every(isLibraryItemLike);

export const parseStoredLibraryItems = (json: string | null | undefined): LibraryItems | null => {
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  return isLibraryItemsPayload(parsed) ? parsed : null;
};

export const createLibraryPersistenceAdapter = (
  storage: LibraryStorage,
): LibraryPersistenceAdapter => ({
  load: async () => {
    try {
      const libraryItems = parseStoredLibraryItems(await storage.get());
      return libraryItems ? { libraryItems } : null;
    } catch {
      return null;
    }
  },
  save: async ({ libraryItems }) => {
    await storage.set(JSON.stringify(libraryItems));
  },
});

export const defaultLibraryStorage = (): LibraryStorage => ({
  get: () => window.api.store.get(LIBRARY_STORE_KEY),
  set: (value) => window.api.store.set(LIBRARY_STORE_KEY, value),
});
