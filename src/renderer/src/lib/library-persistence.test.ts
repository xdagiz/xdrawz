import type { LibraryItems } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLibraryPersistenceAdapter,
  isLibraryItemsPayload,
  parseStoredLibraryItems,
} from "./library-persistence";

const validPayload = [
  { id: "a", elements: [{ id: "el-1" }], status: "published" },
  { id: "b", elements: [], status: "unpublished" },
];
const validJson = JSON.stringify(validPayload);
const validItems = validPayload as unknown as LibraryItems;

const makeStorage = () => ({
  get: vi.fn<() => Promise<string | null>>(),
  set: vi.fn<(value: string | null) => Promise<void>>(),
});

describe("parseStoredLibraryItems", () => {
  it("returns null for empty input", () => {
    expect(parseStoredLibraryItems(null)).toBe(null);
    expect(parseStoredLibraryItems(undefined)).toBe(null);
    expect(parseStoredLibraryItems("")).toBe(null);
  });

  it("returns null for invalid json", () => {
    expect(parseStoredLibraryItems("{")).toBe(null);
  });

  it("returns null when the payload is not an array", () => {
    expect(parseStoredLibraryItems('{"elements":[]}')).toBe(null);
    expect(parseStoredLibraryItems('"str"')).toBe(null);
  });

  it("returns null when an item lacks elements", () => {
    expect(parseStoredLibraryItems('[{"id":"a"}]')).toBe(null);
    expect(parseStoredLibraryItems('["nope"]')).toBe(null);
  });

  it("parses a valid payload", () => {
    expect(parseStoredLibraryItems(validJson)).toEqual(validPayload);
  });
});

describe("isLibraryItemsPayload", () => {
  it("validates the payload shape", () => {
    expect(isLibraryItemsPayload(validPayload)).toBe(true);
    expect(isLibraryItemsPayload([])).toBe(true);
    expect(isLibraryItemsPayload([null])).toBe(false);
    expect(isLibraryItemsPayload({ elements: [] })).toBe(false);
  });
});

describe("createLibraryPersistenceAdapter", () => {
  it("loads and parses stored items", async () => {
    const storage = makeStorage();
    storage.get.mockResolvedValue(validJson);

    const adapter = createLibraryPersistenceAdapter(storage);
    await expect(adapter.load({ source: "load" })).resolves.toEqual({
      libraryItems: validPayload,
    });
  });

  it("returns null when nothing is stored", async () => {
    const storage = makeStorage();
    storage.get.mockResolvedValue(null);

    const adapter = createLibraryPersistenceAdapter(storage);
    await expect(adapter.load({ source: "save" })).resolves.toBe(null);
  });

  it("returns null when storage access fails", async () => {
    const storage = makeStorage();
    storage.get.mockRejectedValue(new Error("ipc down"));

    const adapter = createLibraryPersistenceAdapter(storage);
    await expect(adapter.load({ source: "load" })).resolves.toBe(null);
  });

  it("saves serialized items", async () => {
    const storage = makeStorage();
    storage.set.mockResolvedValue(undefined);

    const adapter = createLibraryPersistenceAdapter(storage);
    await adapter.save({ libraryItems: validItems });

    expect(storage.set).toHaveBeenCalledWith(validJson);
  });
});

describe("adapter save reporting", () => {
  it("reports failures and rethrows", async () => {
    const storage = makeStorage();
    storage.set.mockRejectedValue(new Error("too large"));
    const onSaveError = vi.fn();
    const onSaveSuccess = vi.fn();

    const adapter = createLibraryPersistenceAdapter(storage, { onSaveError, onSaveSuccess });
    await expect(adapter.save({ libraryItems: validItems })).rejects.toThrow("too large");
    expect(onSaveError).toHaveBeenCalledTimes(1);
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  it("reports success without error", async () => {
    const storage = makeStorage();
    storage.set.mockResolvedValue(undefined);
    const onSaveError = vi.fn();
    const onSaveSuccess = vi.fn();

    const adapter = createLibraryPersistenceAdapter(storage, { onSaveError, onSaveSuccess });
    await adapter.save({ libraryItems: validItems });
    expect(onSaveSuccess).toHaveBeenCalledTimes(1);
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("works without reporting callbacks", async () => {
    const storage = makeStorage();
    storage.set.mockResolvedValue(undefined);

    const adapter = createLibraryPersistenceAdapter(storage);
    await expect(adapter.save({ libraryItems: validItems })).resolves.toBeUndefined();
  });
});
