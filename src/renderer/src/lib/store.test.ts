import type { DrawingsSnapshot, FileEntry, FilesChangedEvent } from "@shared/ipc";
import { DEFAULT_SETTINGS, FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

import type { DrawingSessionControls } from "@/lib/drawing-session";
import { THEME_STORAGE_KEY } from "@/lib/theme";

import { toAppError } from "./app-error";
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
    dismissedConflictKey: null,
  });
};

const registerSession = (allowed: boolean) => {
  useStore.getState().registerSession({
    ensureCleanOrConfirm: async () => allowed,
    getSerializedContent: () => "{}",
    saveNow: async () => {},
  } as unknown as DrawingSessionControls);
};

const registerSessionWithContent = (content: string | null) => {
  useStore.getState().registerSession({
    ensureCleanOrConfirm: async () => true,
    getSerializedContent: () => content,
    saveNow: async () => {},
  } as unknown as DrawingSessionControls);
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
    it("restores the last opened file only when it still exists as a file entry", () => {
      const snapshot = (lastOpenedFileId: string | null) =>
        ({
          info: { path: null, displayName: null, configured: false, missing: false },
          entries: mockEntries,
          prefs: { lastOpenedFileId },
        }) satisfies DrawingsSnapshot;

      useStore.getState().loadSnapshot(snapshot("file-1"));
      expect(useStore.getState().openFileId).toBe("file-1");

      useStore.getState().loadSnapshot(snapshot(null));
      expect(useStore.getState().openFileId).toBeNull();

      useStore.getState().loadSnapshot(snapshot("non-existent-id"));
      expect(useStore.getState().openFileId).toBeNull();

      useStore.getState().loadSnapshot(snapshot("dir-1"));
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
    it("persists opens and closes to lastOpenedFileId", async () => {
      useStore.setState({ entries: mockEntries });

      await useStore.getState().setOpenFileId("file-1");

      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).toHaveBeenCalledWith("lastOpenedFileId", "file-1");

      await useStore.getState().setOpenFileId(null);

      expect(useStore.getState().openFileId).toBeNull();
      expect(window.api.store.set).toHaveBeenLastCalledWith("lastOpenedFileId", null);
    });

    it("rejects invalid, duplicate, and directory targets without persisting", async () => {
      useStore.setState({
        entries: mockEntries,
        openFileId: "file-1",
        error: toAppError(new Error("some previous error"), "save"),
      });

      await useStore.getState().setOpenFileId("non-existent-id");
      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).not.toHaveBeenCalled();

      await useStore.getState().setOpenFileId("dir-1");
      expect(useStore.getState().openFileId).toBe("file-1");
      expect(window.api.store.set).not.toHaveBeenCalled();

      await useStore.getState().setOpenFileId("file-1");
      expect(window.api.store.set).not.toHaveBeenCalled();
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

  it("ignores stale revisions, including after a snapshot reload", () => {
    useStore.setState({ entries: mockEntries, filesRevision: 5 });

    useStore.getState().applyEntries(event({ revision: 3, entries: [] }));

    expect(useStore.getState().entries).toEqual(mockEntries);
    expect(useStore.getState().filesRevision).toBe(5);

    useStore.getState().loadSnapshot({
      info: baseInfo,
      entries: [mockEntries[0]],
      prefs: { lastOpenedFileId: null },
    });

    useStore.getState().applyEntries(event({ revision: 4, entries: [] }));
    expect(useStore.getState().entries).toEqual([mockEntries[0]]);
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
      entries: [mockEntries[0]],
      prefs: { lastOpenedFileId: null },
    });

    expect(useStore.getState().filesRevision).toBe(7);
    expect(useStore.getState().entries).toEqual([mockEntries[0]]);

    // Stale rev must still be ignored after reload.
    useStore.getState().applyEntries(event({ revision: 4, entries: [] }));
    expect(useStore.getState().entries).toEqual([mockEntries[0]]);
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

  it("records the write mtime so a later listing of our own save is not a conflict", async () => {
    vi.mocked(window.api.files.write).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}");
    expect(ok).toBe(true);

    const savedAt = useStore.getState().entries.find((e) => e.id === "file-1")!.modifiedAt;
    expect(savedAt).toBeGreaterThanOrEqual(100);

    useStore.setState({ dirtyById: { "file-1": true } });
    const listed = mockEntries.map((e) => (e.id === "file-1" ? { ...e, modifiedAt: savedAt } : e));
    useStore.getState().applyEntries({
      entries: listed,
      revision: 1,
      root: "/drawings",
      info: baseInfo,
    });

    expect(useStore.getState().externalConflict).toBeNull();

    const later = mockEntries.map((e) =>
      e.id === "file-1" ? { ...e, modifiedAt: savedAt + 1000 } : e,
    );
    useStore.getState().applyEntries({
      entries: later,
      revision: 2,
      root: "/drawings",
      info: baseInfo,
    });

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId: "file-1",
      diskModifiedAt: savedAt + 1000,
    });
  });

  it("sets a missing conflict on File not found without prompting during autosave", async () => {
    vi.mocked(window.api.files.write).mockRejectedValue(new Error(FILE_NOT_FOUND_MESSAGE));

    const ok = await useStore.getState().saveFile("file-1", "{}");

    expect(ok).toBe(false);
    expect(window.api.dialog.fileRecover).not.toHaveBeenCalled();
    expect(window.api.files.writeRecover).not.toHaveBeenCalled();
    expect(useStore.getState().externalConflict).toEqual({ type: "missing", fileId: "file-1" });
  });

  it("offers recover on File not found even with the IPC error prefix attached", async () => {
    vi.mocked(window.api.files.write).mockRejectedValue(
      new Error(`Error invoking remote method 'files:write': Error: ${FILE_NOT_FOUND_MESSAGE}`),
    );
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("recover");
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}", "explicit");

    expect(ok).toBe(true);
    expect(window.api.dialog.fileRecover).toHaveBeenCalled();
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", "{}");
    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().dirtyById["file-1"]).toBeUndefined();
  });

  it("discards missing file when user chooses discard", async () => {
    vi.mocked(window.api.files.write).mockRejectedValue(new Error(FILE_NOT_FOUND_MESSAGE));
    vi.mocked(window.api.dialog.fileRecover).mockResolvedValue("discard");

    const ok = await useStore.getState().saveFile("file-1", "{}", "explicit");

    expect(ok).toBe(true);
    expect(useStore.getState().openFileId).toBeNull();
    expect(useStore.getState().externalConflict).toBeNull();
    expect(window.api.store.set).toHaveBeenCalledWith("lastOpenedFileId", null);
  });

  it("does not prompt or write while any conflict is active during autosave", async () => {
    useStore.setState({
      externalConflict: { type: "changed", fileId: "file-1", diskModifiedAt: 999 },
    });

    expect(await useStore.getState().saveFile("file-1", "{}")).toBe(false);
    expect(window.api.dialog.fileChanged).not.toHaveBeenCalled();
    expect(window.api.files.write).not.toHaveBeenCalled();

    useStore.setState({
      externalConflict: { type: "missing", fileId: "file-1" },
    });

    expect(await useStore.getState().saveFile("file-1", "{}")).toBe(false);
    expect(window.api.files.write).not.toHaveBeenCalled();
    expect(window.api.files.writeRecover).not.toHaveBeenCalled();
    expect(window.api.dialog.fileRecover).not.toHaveBeenCalled();
  });

  it("prompts on changed conflict before an explicit write", async () => {
    useStore.setState({
      externalConflict: { type: "changed", fileId: "file-1", diskModifiedAt: 999 },
    });
    vi.mocked(window.api.dialog.fileChanged).mockResolvedValue("overwrite");
    vi.mocked(window.api.files.write).mockResolvedValue(undefined);

    const ok = await useStore.getState().saveFile("file-1", "{}", "explicit");

    expect(ok).toBe(true);
    expect(window.api.dialog.fileChanged).toHaveBeenCalled();
    expect(window.api.files.write).toHaveBeenCalledWith("file-1", "{}");
    expect(useStore.getState().externalConflict).toBeNull();
  });

  it("does not re-prompt a dismissed changed conflict until mtime changes", async () => {
    useStore.setState({
      externalConflict: { type: "changed", fileId: "file-1", diskModifiedAt: 999 },
    });
    vi.mocked(window.api.dialog.fileChanged).mockResolvedValue("cancel");

    expect(await useStore.getState().resolveChangedConflict()).toBe("cancel");
    expect(window.api.dialog.fileChanged).toHaveBeenCalledTimes(1);

    expect(await useStore.getState().resolveChangedConflict()).toBe("cancel");
    expect(window.api.dialog.fileChanged).toHaveBeenCalledTimes(1);

    expect(await useStore.getState().resolveChangedConflict({ force: true })).toBe("cancel");
    expect(window.api.dialog.fileChanged).toHaveBeenCalledTimes(2);
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
});

describe("renameFile/deleteFile cancellation", () => {
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
          rename: vi.fn(),
          delete: vi.fn(),
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

  it("returns false without renaming or deleting when the unsaved prompt is cancelled", async () => {
    registerSession(false);

    expect(await useStore.getState().renameFile("file-1", "renamed")).toBe(false);
    expect(window.api.files.rename).not.toHaveBeenCalled();

    expect(await useStore.getState().deleteFile("file-1")).toBe(false);
    expect(window.api.files.delete).not.toHaveBeenCalled();
  });

  it("renameFile returns true and updates the open id on success", async () => {
    registerSession(true);
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "renamed.excalidraw",
      name: "renamed.excalidraw",
      kind: "file",
      parentId: null,
      modifiedAt: 400,
      size: 100,
    });
    vi.mocked(window.api.files.list).mockResolvedValue([
      { ...mockEntries[0], id: "renamed.excalidraw", name: "renamed.excalidraw" },
      mockEntries[1],
      mockEntries[2],
    ]);

    const ok = await useStore.getState().renameFile("file-1", "renamed");

    expect(ok).toBe(true);
    expect(useStore.getState().openFileId).toBe("renamed.excalidraw");
    expect(window.api.files.list).not.toHaveBeenCalled();
    const ids = useStore.getState().entries.map((e) => e.id);
    expect(ids).toContain("renamed.excalidraw");
    expect(ids).not.toContain("file-1");
  });

  it("deleteFile returns true on success", async () => {
    const ok = await useStore.getState().deleteFile("file-2");

    expect(ok).toBe(true);
    expect(window.api.files.delete).toHaveBeenCalledWith("file-2");
    expect(window.api.files.list).not.toHaveBeenCalled();
    expect(useStore.getState().entries.some((e) => e.id === "file-2")).toBe(false);
  });
});

describe("retryRecover", () => {
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
      externalConflict: { type: "missing", fileId: "file-1" },
      error: toAppError(new Error("recovery boom"), "recover"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries writeRecover without re-opening the recovery dialog", async () => {
    registerSessionWithContent('{"recovered":true}');
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(undefined);

    const ok = await useStore.getState().retryRecover();

    expect(ok).toBe(true);
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", '{"recovered":true}');
    expect(window.api.dialog.fileRecover).not.toHaveBeenCalled();
    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().error).toBeNull();
    expect(useStore.getState().dirtyById["file-1"]).toBeUndefined();
  });

  it("keeps the conflict and error when writeRecover fails again", async () => {
    registerSessionWithContent("{}");
    vi.mocked(window.api.files.writeRecover).mockRejectedValue(new Error("still boom"));

    const ok = await useStore.getState().retryRecover();

    expect(ok).toBe(false);
    expect(useStore.getState().externalConflict).toEqual({ type: "missing", fileId: "file-1" });
    expect(useStore.getState().error?.operation).toBe("recover");

    registerSessionWithContent(null);
    expect(await useStore.getState().retryRecover()).toBe(false);
    expect(window.api.files.writeRecover).toHaveBeenCalledTimes(1);
    expect(useStore.getState().error?.retryable).toBe(false);
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

  it("updateSettings writes the mirror on success and initSettings reconciles", async () => {
    vi.mocked(window.api.settings.update).mockResolvedValue({ theme: "dark" });

    await useStore.getState().updateSettings({ theme: "dark" });

    expect(window.api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    // oxlint-disable-next-line typescript/unbound-method -- localStorage methods keep `this` through the member call
    expect(window.localStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(useStore.getState().settings.theme).toBe("dark");

    vi.mocked(window.api.settings.get).mockResolvedValue({ theme: "light" });

    await useStore.getState().initSettings();

    expect(useStore.getState().settings.theme).toBe("light");
    // oxlint-disable-next-line typescript/unbound-method -- localStorage methods keep `this` through the member call
    expect(window.localStorage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "light");
  });
});
