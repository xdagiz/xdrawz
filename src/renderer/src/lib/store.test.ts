import type { DrawingsSnapshot, FileEntry, FilesChangedEvent } from "@shared/ipc";
import { DEFAULT_SETTINGS, FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { THEME_STORAGE_KEY } from "@/lib/theme";

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

const baseInfo = {
  path: "/drawings",
  displayName: "drawings",
  configured: true,
  missing: false,
};

const resetStore = () => {
  useStore.setState({
    drawings: null,
    entries: [],
    openFileId: null,
    dirtyById: {},
    error: null,
    activeSession: null,
    filesRevision: 0,
    externalConflict: null,
    editorEpoch: 0,
  });
};

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
          fileRecover: vi.fn(),
          fileChanged: vi.fn(),
        },
        files: {
          write: vi.fn(),
          writeRecover: vi.fn(),
          list: vi.fn(),
        },
      },
    });

    resetStore();
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

describe("applyEntries + conflicts", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      api: {
        store: { set: vi.fn(), get: vi.fn() },
        dialog: {
          unsavedChanges: vi.fn(),
          fileRecover: vi.fn(),
          fileChanged: vi.fn(),
        },
        files: {
          write: vi.fn(),
          writeRecover: vi.fn(),
          list: vi.fn(),
        },
      },
    });
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const event = (overrides: Partial<FilesChangedEvent>): FilesChangedEvent => ({
    entries: mockEntries,
    revision: 1,
    root: "/drawings",
    info: baseInfo,
    ...overrides,
  });

  it("ignores stale revisions", () => {
    useStore.setState({ entries: mockEntries, filesRevision: 5 });

    useStore.getState().applyEntries(event({ revision: 3, entries: [] }));

    expect(useStore.getState().entries).toEqual(mockEntries);
    expect(useStore.getState().filesRevision).toBe(5);
  });

  it("updates entries and revision on fresh events", () => {
    useStore.setState({ entries: [], filesRevision: 0 });
    const next = [mockEntries[0]!];

    useStore.getState().applyEntries(event({ revision: 1, entries: next }));

    expect(useStore.getState().entries).toEqual(next);
    expect(useStore.getState().filesRevision).toBe(1);
  });

  it("clears clean open file when it disappears", () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: {},
      filesRevision: 0,
    });

    useStore.getState().applyEntries(
      event({
        revision: 1,
        entries: mockEntries.filter((e) => e.id !== "file-1"),
      }),
    );

    expect(useStore.getState().openFileId).toBeNull();
    expect(useStore.getState().externalConflict).toBeNull();
  });

  it("sets missing conflict when dirty open file disappears", () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { "file-1": true },
      filesRevision: 0,
    });

    useStore.getState().applyEntries(
      event({
        revision: 1,
        entries: mockEntries.filter((e) => e.id !== "file-1"),
      }),
    );

    expect(useStore.getState().openFileId).toBe("file-1");
    expect(useStore.getState().externalConflict).toEqual({
      type: "missing",
      fileId: "file-1",
    });
    expect(useStore.getState().dirtyById["file-1"]).toBe(true);
  });

  it("sets changed conflict when dirty open file mtime increases", () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { "file-1": true },
      filesRevision: 0,
    });

    const bumped = mockEntries.map((e) => (e.id === "file-1" ? { ...e, modifiedAt: 999 } : e));

    useStore.getState().applyEntries(event({ revision: 1, entries: bumped }));

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId: "file-1",
      diskModifiedAt: 999,
    });
  });

  it("keeps changed conflict sticky across subsequent events", () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { "file-1": true },
      filesRevision: 0,
    });

    const bumped = mockEntries.map((e) => (e.id === "file-1" ? { ...e, modifiedAt: 999 } : e));
    useStore.getState().applyEntries(event({ revision: 1, entries: bumped }));

    // Same mtimes again (entries already updated) — conflict must stick.
    useStore.getState().applyEntries(event({ revision: 2, entries: bumped }));

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId: "file-1",
      diskModifiedAt: 999,
    });
  });

  it("reloadOpenFileFromDisk clears conflict, dirty flag, and bumps editorEpoch", () => {
    useStore.setState({
      openFileId: "file-1",
      dirtyById: { "file-1": true },
      externalConflict: { type: "changed", fileId: "file-1", diskModifiedAt: 999 },
      editorEpoch: 0,
    });

    useStore.getState().reloadOpenFileFromDisk();

    const state = useStore.getState();
    expect(state.externalConflict).toBeNull();
    expect(state.dirtyById["file-1"]).toBeUndefined();
    expect(state.editorEpoch).toBe(1);
  });

  it("loadSnapshot preserves filesRevision so stale watcher events stay dropped", () => {
    useStore.setState({ filesRevision: 7, entries: mockEntries });

    useStore.getState().loadSnapshot({
      info: baseInfo,
      entries: [mockEntries[0]!],
      prefs: { lastOpenedFileId: null },
    });

    expect(useStore.getState().filesRevision).toBe(7);
    expect(useStore.getState().entries).toEqual([mockEntries[0]!]);

    // Stale rev must still be ignored after reload.
    useStore.getState().applyEntries(event({ revision: 4, entries: [] }));
    expect(useStore.getState().entries).toEqual([mockEntries[0]!]);
  });
});

describe("saveFile recovery", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      api: {
        store: { set: vi.fn(), get: vi.fn() },
        dialog: {
          unsavedChanges: vi.fn(),
          fileRecover: vi.fn(),
          fileChanged: vi.fn(),
        },
        files: {
          write: vi.fn(),
          writeRecover: vi.fn(),
          list: vi.fn().mockResolvedValue(mockEntries),
        },
      },
    });
    resetStore();
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { "file-1": true },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers recover on File not found even without a pre-set conflict", async () => {
    vi.mocked(window.api.files.write).mockRejectedValue(new Error(FILE_NOT_FOUND_MESSAGE));
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("recover");
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}");

    expect(ok).toBe(true);
    expect(window.api.dialog.fileRecover).toHaveBeenCalled();
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", "{}");
    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().dirtyById["file-1"]).toBeUndefined();
  });

  it("discards missing file when user chooses discard", async () => {
    vi.mocked(window.api.files.write).mockRejectedValue(new Error(FILE_NOT_FOUND_MESSAGE));
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("discard");

    const ok = await useStore.getState().saveFile("file-1", "{}");

    expect(ok).toBe(true);
    expect(useStore.getState().openFileId).toBeNull();
    expect(useStore.getState().externalConflict).toBeNull();
    expect(window.api.store.set).toHaveBeenCalledWith("lastOpenedFileId", null);
  });

  it("prompts on changed conflict before writing", async () => {
    useStore.setState({
      externalConflict: { type: "changed", fileId: "file-1", diskModifiedAt: 999 },
    });
    vi.mocked(window.api.dialog.fileChanged).mockResolvedValue("overwrite");
    vi.mocked(window.api.files.write).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}");

    expect(ok).toBe(true);
    expect(window.api.dialog.fileChanged).toHaveBeenCalled();
    expect(window.api.files.write).toHaveBeenCalledWith("file-1", "{}");
    expect(useStore.getState().externalConflict).toBeNull();
  });

  it("resolveMissingConflict recovers with provided content", async () => {
    useStore.setState({
      externalConflict: { type: "missing", fileId: "file-1" },
    });
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("recover");
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(undefined);

    const choice = await useStore.getState().resolveMissingConflict('{"recovered":true}');

    expect(choice).toBe("recover");
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", '{"recovered":true}');
    expect(useStore.getState().externalConflict).toBeNull();
  });

  it("skips normal write when missing conflict is already known", async () => {
    useStore.setState({
      externalConflict: { type: "missing", fileId: "file-1" },
    });
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("recover");
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}");

    expect(ok).toBe(true);
    expect(window.api.files.write).not.toHaveBeenCalled();
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", "{}");
  });
});

describe("settings theme sync", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      api: {
        settings: {
          get: vi.fn(),
          update: vi.fn(),
        },
        store: { set: vi.fn(), get: vi.fn() },
        dialog: {
          unsavedChanges: vi.fn(),
          fileRecover: vi.fn(),
          fileChanged: vi.fn(),
        },
        files: {
          write: vi.fn(),
          writeRecover: vi.fn(),
          list: vi.fn(),
        },
      },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });

    resetStore();
    useStore.setState({ settings: DEFAULT_SETTINGS });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds settings.theme from localStorage when window exists", async () => {
    vi.mocked(window.localStorage.getItem).mockReturnValue("dark");
    vi.resetModules();
    const { useStore: freshStore } = await import("./store");

    expect(freshStore.getState().settings.theme).toBe("dark");
  });

  it("updateSettings writes the mirror on success", async () => {
    vi.mocked(window.api.settings.update).mockResolvedValue({ theme: "dark" });

    await useStore.getState().updateSettings({ theme: "dark" });

    expect(window.api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    expect(window.localStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(useStore.getState().settings.theme).toBe("dark");
  });

  it("updateSettings does not write the mirror when the IPC call fails", async () => {
    vi.mocked(window.api.settings.update).mockRejectedValue(new Error("settings boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await useStore.getState().updateSettings({ theme: "dark" });

    expect(window.api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(useStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    errorSpy.mockRestore();
  });

  it("initSettings reconciles the store and mirror from IPC", async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({ theme: "light" });

    await useStore.getState().initSettings();

    expect(useStore.getState().settings.theme).toBe("light");
    expect(window.localStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
  });
});
