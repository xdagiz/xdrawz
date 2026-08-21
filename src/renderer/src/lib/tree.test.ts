import type { FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import {
  EXPANDED_FOLDERS_STORAGE_KEY,
  ancestorIdsOf,
  buildSortedChildIndex,
  readExpandedFolderIds,
  sortSiblings,
  writeExpandedFolderIds,
} from "./tree";

const entry = (id: string, kind: "file" | "directory" = "file"): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  parentId: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : null,
  modifiedAt: 100,
  size: 10,
});

const namesOf = (children: FileEntry[] | undefined) => (children ?? []).map((e) => e.name);

describe("sortSiblings", () => {
  it("orders directories before files", () => {
    const sorted = sortSiblings([entry("b.excalidraw"), entry("a", "directory")]);

    expect(sorted.map((e) => e.id)).toEqual(["a", "b.excalidraw"]);
  });

  it("sorts case-insensitively within each kind", () => {
    const sorted = sortSiblings([
      entry("Zebra.excalidraw"),
      entry("apple", "directory"),
      entry("Banana.excalidraw"),
      entry("cherry", "directory"),
    ]);

    expect(sorted.map((e) => e.name)).toEqual([
      "apple",
      "cherry",
      "Banana.excalidraw",
      "Zebra.excalidraw",
    ]);
  });

  it("uses natural number order for names", () => {
    const sorted = sortSiblings([entry("sketch 10.excalidraw"), entry("sketch 2.excalidraw")]);

    expect(sorted.map((e) => e.name)).toEqual(["sketch 2.excalidraw", "sketch 10.excalidraw"]);
  });
});

describe("buildSortedChildIndex", () => {
  it("groups children under their parents and roots under null", () => {
    const entries = [
      entry("root.excalidraw"),
      entry("vacation/beach.excalidraw"),
      entry("vacation", "directory"),
    ];

    const index = buildSortedChildIndex(entries);

    expect(namesOf(index.get(null))).toEqual(["vacation", "root.excalidraw"]);
    expect(namesOf(index.get("vacation"))).toEqual(["beach.excalidraw"]);
  });

  it("sorts children inside every folder", () => {
    const entries = [
      entry("zoo/sketch 10.excalidraw"),
      entry("zoo/sketch 2.excalidraw"),
      entry("zoo/nested", "directory"),
    ];

    const index = buildSortedChildIndex(entries);

    expect(namesOf(index.get("zoo"))).toEqual([
      "nested",
      "sketch 2.excalidraw",
      "sketch 10.excalidraw",
    ]);
  });
});

describe("ancestorIdsOf", () => {
  it("returns ancestors ordered root first", () => {
    expect(ancestorIdsOf("a/b/c.excalidraw")).toEqual(["a", "a/b"]);
  });

  it("returns empty for root-level ids", () => {
    expect(ancestorIdsOf("a.excalidraw")).toEqual([]);
  });
});

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("expanded folder storage", () => {
  it("roundtrips expanded ids", () => {
    const storage = memoryStorage();

    writeExpandedFolderIds(storage, ["a", "a/b"]);

    expect(readExpandedFolderIds(storage)).toEqual(new Set(["a", "a/b"]));
  });

  it("returns an empty set for missing or malformed values", () => {
    expect(readExpandedFolderIds(memoryStorage())).toEqual(new Set());
    expect(readExpandedFolderIds(memoryStorage({ k: "not json" }))).toEqual(new Set());
    expect(
      readExpandedFolderIds(memoryStorage({ [EXPANDED_FOLDERS_STORAGE_KEY]: '[1,null,"a"]' })),
    ).toEqual(new Set(["a"]));
  });

  it("tolerates a throwing storage", () => {
    const throwing = {
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new Error("boom");
      },
    };

    expect(readExpandedFolderIds(throwing)).toEqual(new Set());
    expect(() => writeExpandedFolderIds(throwing, ["a"])).not.toThrow();
  });
});
