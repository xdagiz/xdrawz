import { parentIdOf, type FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import {
  applySubtreeDelete,
  isInsideSubtree,
  remapId,
  remapNullableId,
} from "./entry-tree";

const entry = (id: string, kind: "file" | "directory" = "file"): FileEntry => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  parentId: parentIdOf(id),
  modifiedAt: 100,
  size: 10,
});

const baseState = () => ({
  entries: [
    entry("notes", "directory"),
    entry("notes/a.excalidraw"),
    entry("notes/deep", "directory"),
    entry("notes/deep/b.excalidraw"),
    entry("z.excalidraw"),
  ],
  openFileId: null,
  dirtyById: {},
});

describe("remapId", () => {
  it("rewrites the root itself", () => {
    expect(remapId("a", "a", "b/c")).toBe("b/c");
  });

  it("rewrites descendants by suffix", () => {
    expect(remapId("a/x.excalidraw", "a", "b/c")).toBe("b/c/x.excalidraw");
  });

  it("does not corrupt sibling-prefixed ids", () => {
    expect(remapId("a/bc.excalidraw", "a/b", "x")).toBe("a/bc.excalidraw");
  });

  it("leaves unrelated ids untouched", () => {
    expect(remapId("ab.excalidraw", "a", "x/y")).toBe("ab.excalidraw");
  });
});

describe("remapNullableId", () => {
  it("maps null and undefined to null", () => {
    expect(remapNullableId(null, "a", "b")).toBeNull();
    expect(remapNullableId(undefined, "a", "b")).toBeNull();
  });
});

describe("isInsideSubtree", () => {
  it("accepts the root and descendants, rejects nullish and outsiders", () => {
    expect(isInsideSubtree("a", "a")).toBe(true);
    expect(isInsideSubtree("a", "a/b.excalidraw")).toBe(true);
    expect(isInsideSubtree("a", "a/bc.excalidraw")).toBe(true);
    expect(isInsideSubtree("a/b", "a/bc.excalidraw")).toBe(false);
    expect(isInsideSubtree("a", null)).toBe(false);
    expect(isInsideSubtree("a", undefined)).toBe(false);
  });
});

describe("applySubtreeDelete", () => {
  it("removes a directory subtree and keeps unrelated entries by reference", () => {
    const state = baseState();
    const untouched = state.entries[4];
    const next = applySubtreeDelete(state, "notes");

    expect(next.entries.map((e) => e.id)).toEqual(["z.excalidraw"]);
    expect(next.entries[0]).toBe(untouched);
    expect(next.openedRemoved).toBe(false);
    expect(next.openFileId).toBeNull();
  });

  it("nulls the open file when it lives inside the subtree", () => {
    const state = { ...baseState(), openFileId: "notes/deep/b.excalidraw" };
    const next = applySubtreeDelete(state, "notes");

    expect(next.openFileId).toBeNull();
    expect(next.openedRemoved).toBe(true);
  });

  it("keeps the open file when it lives outside the subtree", () => {
    const state = { ...baseState(), openFileId: "z.excalidraw" };
    const next = applySubtreeDelete(state, "notes");

    expect(next.openFileId).toBe("z.excalidraw");
    expect(next.openedRemoved).toBe(false);
  });

  it("prunes dirty keys inside the subtree and keeps outside ones", () => {
    const state = {
      ...baseState(),
      dirtyById: { "notes/a.excalidraw": true as const, "z.excalidraw": true as const },
    };
    const next = applySubtreeDelete(state, "notes");

    expect(next.dirtyById).toEqual({ "z.excalidraw": true });
  });

  it("deletes a bare file root", () => {
    const state = { ...baseState(), dirtyById: { "z.excalidraw": true as const } };
    const next = applySubtreeDelete(state, "z.excalidraw");

    expect(next.entries.map((e) => e.id)).toEqual([
      "notes",
      "notes/a.excalidraw",
      "notes/deep",
      "notes/deep/b.excalidraw",
    ]);
    expect(next.dirtyById).toEqual({});
  });

  it("handles an empty dirty map", () => {
    const next = applySubtreeDelete(baseState(), "notes");
    expect(next.dirtyById).toEqual({});
  });
});
