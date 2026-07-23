import type { DrawingsSnapshot, FileEntry } from "@shared/ipc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { useStore } from "./store";

const mockEntries: FileEntry[] = [
  {
    id: "file-1",
    name: "drawing.excalidraw",
    kind: "file",
    parentId: null,
    modifiedAt: 100,
    size: 100,
  },
  {
    id: "file-2",
    name: "notes.excalidraw",
    kind: "file",
    parentId: null,
    modifiedAt: 200,
    size: 200,
  },
  { id: "dir-1", name: "subfolder", kind: "directory", parentId: null, modifiedAt: 300, size: 0 },
];

describe("lastOpenedFileId", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      api: {
        store: {
          set: vi.fn(),
          get: vi.fn(),
        },
        dialog: {
          unsavedChanges: vi.fn(),
        },
      },
    });

    useStore.setState({
      drawings: null,
      entries: [],
      openFileId: null,
      dirtyById: {},
      error: null,
      activeSession: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadSnapshot", () => {
    it("opens the file when lastOpenedFileId points to an existing file entry", () => {
      const snapshot = {
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: "file-1" },
      } satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot);

      expect(useStore.getState().openFileId).toBe("file-1");
    });

    it("sets openFileId to null when lastOpenedFileId is null", () => {
      const snapshot = {
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: null },
      } satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot);

      expect(useStore.getState().openFileId).toBeNull();
    });

    it("sets openFileId to null when lastOpenedFileId does not exist in entries", () => {
      const snapshot = {
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: "non-existent-id" },
      } satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot);

      expect(useStore.getState().openFileId).toBeNull();
    });

    it("sets openFileId to null when lastOpenedFileId points to a directory", () => {
      const snapshot = {
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: "dir-1" },
      } satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot);

      expect(useStore.getState().openFileId).toBeNull();
    });

    it("resets dirtyById to empty on load regardless of prior state", () => {
      useStore.setState({ dirtyById: { "file-1": true } });

      const snapshot = {
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: [],
        prefs: { lastOpenedFileId: null },
      } satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot);

      expect(useStore.getState().dirtyById).toEqual({});
    });
  });

  describe("setOpenFileId", () => {
    it("persists null when closing a file", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
      });

      await useStore.getState().setOpenFileId(null);

      expect(useStore.getState().openFileId).toBeNull();
      expect(window.api.store.set).toHaveBeenCalledWith("lastOpenedFileId", null);
    });

    it("persists the file id when opening a valid file", async () => {
      useStore.setState({ entries: mockEntries });

      await useStore.getState().setOpenFileId("file-1");

      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).toHaveBeenCalledWith("lastOpenedFileId", "file-1");
    });

    it("does not change openFileId or persist when fileId does not exist in entries", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
      });

      await useStore.getState().setOpenFileId("non-existent-id");

      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).not.toHaveBeenCalled();
    });

    it("does not persist when fileId matches the current openFileId (early return)", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
      });

      await useStore.getState().setOpenFileId("file-1");

      expect(window.api.store.set).not.toHaveBeenCalled();
    });

    it("does not change openFileId or persist when fileId is a directory", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
      });

      await useStore.getState().setOpenFileId("dir-1");

      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).not.toHaveBeenCalled();
    });

    it("clears error when attempting to open an invalid fileId", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
        error: "some previous error",
      });

      await useStore.getState().setOpenFileId("non-existent-id");

      expect(useStore.getState().error).toBeNull();
    });
  });
});
