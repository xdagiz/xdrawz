import type { FileEntry } from "@shared/ipc";
import { describe, expect, it } from "vite-plus/test";

import { conflictBelongsTo, conflictKeyOf, reduceEntries } from "./conflicts";

const entry = (id: string, modifiedAt: number, kind: "file" | "directory" = "file"): FileEntry => ({
  id,
  name: id,
  kind,
  parentId: null,
  modifiedAt,
  size: 100,
});

const baseState = () => ({
  entries: [entry("a.excalidraw", 100)],
  openFileId: null,
  dirtyById: {},
  externalConflict: null,
  dismissedConflictKey: null,
  editorGeneration: 0,
});

const event = (ids: Array<[string, number]>, revision = 1) => ({
  entries: ids.map(([id, mtime]) => entry(id, mtime)),
  revision,
  root: "/drawings",
});

describe("reduceEntries", () => {
  it("drops the open file when it disappears while clean", () => {
    const state = { ...baseState(), openFileId: "a.excalidraw" };
    const next = reduceEntries(state, event([]));

    expect(next.openFileId).toBeNull();
    expect(next.externalConflict).toBeNull();
    expect(next.editorGeneration).toBe(0);
  });

  it("keeps the open file and flags missing when it disappears while dirty", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      dirtyById: { "a.excalidraw": true as const },
    };
    const next = reduceEntries(state, event([]));

    expect(next.openFileId).toBe("a.excalidraw");
    expect(next.externalConflict).toEqual({ type: "missing", fileId: "a.excalidraw" });
    expect(next.dirtyById["a.excalidraw"]).toBe(true);
  });

  it("bumps the editor generation when the clean open file changes on disk", () => {
    const state = { ...baseState(), openFileId: "a.excalidraw" };
    const next = reduceEntries(state, event([["a.excalidraw", 200]]));

    expect(next.editorGeneration).toBe(1);
    expect(next.externalConflict).toBeNull();
  });

  it("flags a changed conflict when the dirty open file changes on disk", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      dirtyById: { "a.excalidraw": true as const },
    };
    const next = reduceEntries(state, event([["a.excalidraw", 300]]));

    expect(next.externalConflict).toEqual({
      type: "changed",
      fileId: "a.excalidraw",
      diskModifiedAt: 300,
    });
  });

  it("keeps an existing changed conflict when the disk mtime catches up", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      dirtyById: { "a.excalidraw": true as const },
      externalConflict: { type: "changed" as const, fileId: "a.excalidraw", diskModifiedAt: 250 },
    };
    const next = reduceEntries(state, event([["a.excalidraw", 260]]));

    expect(next.externalConflict).toEqual({
      type: "changed",
      fileId: "a.excalidraw",
      diskModifiedAt: 260,
    });

    const older = reduceEntries(state, event([["a.excalidraw", 240]]));
    expect(older.externalConflict).toEqual({
      type: "changed",
      fileId: "a.excalidraw",
      diskModifiedAt: 240,
    });
  });

  it("converts a missing conflict into changed when the file reappears", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      dirtyById: { "a.excalidraw": true as const },
      externalConflict: { type: "missing" as const, fileId: "a.excalidraw" },
    };
    const next = reduceEntries(state, event([["a.excalidraw", 400]]));

    expect(next.externalConflict).toEqual({
      type: "changed",
      fileId: "a.excalidraw",
      diskModifiedAt: 400,
    });
  });

  it("prunes dirty markers for files that no longer exist except under a missing conflict", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      entries: [entry("a.excalidraw", 100), entry("b.excalidraw", 100)],
      dirtyById: { "a.excalidraw": true as const, "b.excalidraw": true as const },
    };

    const pruned = reduceEntries(state, event([["a.excalidraw", 100]]));
    expect(pruned.dirtyById).toEqual({ "a.excalidraw": true });

    const conflicted = {
      ...state,
      externalConflict: { type: "missing" as const, fileId: "a.excalidraw" },
    };
    const kept = reduceEntries(conflicted, event([]));
    expect(kept.dirtyById).toEqual({ "a.excalidraw": true });
  });

  it("retains a dismissal only when the same conflict key recurs", () => {
    const key = conflictKeyOf({ type: "changed", fileId: "a.excalidraw", diskModifiedAt: 200 });
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      dirtyById: { "a.excalidraw": true as const },
      dismissedConflictKey: key,
    };

    const same = reduceEntries(state, event([["a.excalidraw", 200]]));
    expect(same.dismissedConflictKey).toBe(key);

    const other = reduceEntries(state, event([["a.excalidraw", 500]]));
    expect(other.dismissedConflictKey).toBeNull();

    const none = reduceEntries({ ...baseState(), dismissedConflictKey: key }, event([]));
    expect(none.dismissedConflictKey).toBeNull();
  });

  it("clears the conflict for a clean open file even when one existed", () => {
    const state = {
      ...baseState(),
      openFileId: "a.excalidraw",
      externalConflict: { type: "changed" as const, fileId: "a.excalidraw", diskModifiedAt: 50 },
    };
    const next = reduceEntries(state, event([["a.excalidraw", 50]]));

    expect(next.externalConflict).toBeNull();
  });
});

describe("conflictBelongsTo", () => {
  it("matches an active conflict on the same file", () => {
    expect(
      conflictBelongsTo({ type: "missing", fileId: "a.excalidraw" }, null, "a.excalidraw"),
    ).toBe(true);
    expect(
      conflictBelongsTo(
        { type: "changed", fileId: "a.excalidraw", diskModifiedAt: 50 },
        null,
        "a.excalidraw",
      ),
    ).toBe(true);
  });

  it("does not match an active conflict on another file", () => {
    expect(
      conflictBelongsTo({ type: "missing", fileId: "b.excalidraw" }, null, "a.excalidraw"),
    ).toBe(false);
  });

  it("matches dismissed keys belonging to the file", () => {
    expect(conflictBelongsTo(null, "missing:a.excalidraw", "a.excalidraw")).toBe(true);
    expect(conflictBelongsTo(null, "changed:a.excalidraw:50", "a.excalidraw")).toBe(true);
  });

  it("does not match dismissed keys for another file or prefixes of it", () => {
    expect(conflictBelongsTo(null, "missing:b.excalidraw", "a.excalidraw")).toBe(false);
    expect(conflictBelongsTo(null, "changed:a.excalidraw2:50", "a.excalidraw")).toBe(false);
    expect(conflictBelongsTo(null, null, "a.excalidraw")).toBe(false);
  });

  it("matches when both active conflict and dismissed key point at the file", () => {
    const key = conflictKeyOf({ type: "changed", fileId: "a.excalidraw", diskModifiedAt: 50 });
    expect(
      conflictBelongsTo(
        { type: "changed", fileId: "a.excalidraw", diskModifiedAt: 50 },
        key,
        "a.excalidraw",
      ),
    ).toBe(true);
  });
});
