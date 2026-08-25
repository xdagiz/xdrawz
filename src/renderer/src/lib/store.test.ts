import type { DrawingsSnapshot, FileEntry, FilesChangedEvent } from "@shared/ipc";
import { DEFAULT_SETTINGS, FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

import { THEME_STORAGE_KEY } from "@/lib/theme";

import { toAppError } from "./app-error";
import { type BoundDrawingSession, sessionOwner } from "./session-owner";
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
  sessionOwner.setActiveForTest(null);
  useStore.setState({
    drawings: null,
    entries: [],
    openFileId: null,
    recentFileIds: [],
    dirtyById: {},
    error: null,
    filesRevision: 0,
    externalConflict: null,
    editorEpoch: 0,
    editorSessionId: 0,
    dismissedConflictKey: null,
  });
};

const registerSession = (allowed: boolean) => {
  sessionOwner.setActiveForTest({
    ensureCleanOrConfirm: async () => allowed,
    getSerializedContent: () => "{}",
    saveNow: async () => {},
  } as unknown as BoundDrawingSession);
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
    beforeEach(() => {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, reopenLastDrawing: true } });
    });

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

    it("skips restore when reopenLastDrawing is off even with a valid id", () => {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS, reopenLastDrawing: false } });

      useStore.getState().loadSnapshot({
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: "file-1" },
      });

      expect(useStore.getState().openFileId).toBeNull();
    });

    it("restores the last opened file when reopenLastDrawing is on", () => {
      useStore.getState().loadSnapshot({
        info: { path: null, displayName: null, configured: false, missing: false },
        entries: mockEntries,
        prefs: { lastOpenedFileId: "file-1" },
      });

      expect(useStore.getState().openFileId).toBe("file-1");
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

    it("bumps editorSessionId when a different drawing is opened but not when the switch is rejected", async () => {
      useStore.setState({ entries: mockEntries });

      await useStore.getState().setOpenFileId("file-1");
      const afterFirst = useStore.getState().editorSessionId;
      expect(afterFirst).toBe(1);

      await useStore.getState().setOpenFileId("file-2");
      expect(useStore.getState().editorSessionId).toBe(afterFirst + 1);

      await useStore.getState().setOpenFileId("dir-1");
      expect(useStore.getState().editorSessionId).toBe(afterFirst + 1);
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

  it("records the disk mtime returned by write so a later listing of our own save is not a conflict", async () => {
    vi.mocked(window.api.files.write).mockResolvedValue({
      ...mockEntries[0],
      modifiedAt: 500,
      size: 3,
    });

    const ok = await useStore.getState().saveFile("file-1", "{}");
    expect(ok).toBe(true);

    expect(useStore.getState().entries.find((e) => e.id === "file-1")?.modifiedAt).toBe(500);

    useStore.setState({ dirtyById: { "file-1": true } });
    const listed = mockEntries.map((e) => (e.id === "file-1" ? { ...e, modifiedAt: 500 } : e));
    useStore.getState().applyEntries({
      entries: listed,
      revision: 1,
      root: "/drawings",
      info: baseInfo,
    });

    expect(useStore.getState().externalConflict).toBeNull();

    const later = mockEntries.map((e) => (e.id === "file-1" ? { ...e, modifiedAt: 1500 } : e));
    useStore.getState().applyEntries({
      entries: later,
      revision: 2,
      root: "/drawings",
      info: baseInfo,
    });

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId: "file-1",
      diskModifiedAt: 1500,
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
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(mockEntries[0]);

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
    vi.mocked(window.api.files.write).mockResolvedValue(mockEntries[0]);

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
    vi.mocked(window.api.files.writeRecover).mockResolvedValue(mockEntries[0]);

    const choice = await useStore.getState().resolveMissingConflict('{"recovered":true}');

    expect(choice).toBe("recover");
    expect(window.api.files.writeRecover).toHaveBeenCalledWith("file-1", '{"recovered":true}');
    expect(useStore.getState().externalConflict).toBeNull();
  });
});

describe("renameEntry/deleteEntry cancellation", () => {
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

    expect(await useStore.getState().renameEntry("file-1", "renamed")).toBe(false);
    expect(window.api.files.rename).not.toHaveBeenCalled();

    expect(await useStore.getState().deleteEntry("file-1", "trash")).toBe(false);
    expect(window.api.files.delete).not.toHaveBeenCalled();
  });

  it("renameEntry returns true and updates the open id on success", async () => {
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

    const ok = await useStore.getState().renameEntry("file-1", "renamed");

    expect(ok).toBe(true);
    expect(useStore.getState().openFileId).toBe("renamed.excalidraw");
    expect(window.api.files.list).not.toHaveBeenCalled();
    const ids = useStore.getState().entries.map((e) => e.id);
    expect(ids).toContain("renamed.excalidraw");
    expect(ids).not.toContain("file-1");
  });

  it("renameEntry applies the returned entry so the new name reaches the sidebar", async () => {
    registerSession(true);
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "renamed.excalidraw",
      name: "renamed.excalidraw",
      kind: "file",
      parentId: null,
      modifiedAt: 400,
      size: 100,
    });

    const ok = await useStore.getState().renameEntry("file-1", "renamed");

    expect(ok).toBe(true);
    const renamed = useStore.getState().entries.find((e) => e.id === "renamed.excalidraw");
    expect(renamed?.name).toBe("renamed.excalidraw");
    expect(renamed?.modifiedAt).toBe(400);
  });

  it("renameEntry retargets an open descendant when an ancestor folder is renamed", async () => {
    registerSession(true);
    const activeFileIdSpy = vi
      .spyOn(sessionOwner, "getActiveFileId")
      .mockReturnValue("folder/old.excalidraw");
    const retargetSpy = vi.spyOn(sessionOwner, "retargetActive");
    useStore.setState({
      entries: [
        {
          id: "folder",
          name: "folder",
          kind: "directory",
          parentId: null,
          modifiedAt: 10,
          size: 0,
        },
        {
          id: "folder/old.excalidraw",
          name: "old.excalidraw",
          kind: "file",
          parentId: "folder",
          modifiedAt: 20,
          size: 5,
        },
      ],
      openFileId: "folder/old.excalidraw",
      dirtyById: {},
    });
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "renamed",
      name: "renamed",
      kind: "directory",
      parentId: null,
      modifiedAt: 30,
      size: 0,
    });

    const ok = await useStore.getState().renameEntry("folder", "renamed");

    expect(ok).toBe(true);
    expect(retargetSpy).toHaveBeenCalledWith("folder/old.excalidraw", "renamed/old.excalidraw");
    activeFileIdSpy.mockRestore();
    retargetSpy.mockRestore();
  });

  it("renameEntry re-sorts entries when a rename changes lexicographic order", async () => {
    registerSession(true);
    useStore.setState({
      entries: [
        {
          id: "a/b.excalidraw",
          name: "b.excalidraw",
          kind: "file",
          parentId: "a",
          modifiedAt: 10,
          size: 1,
        },
        {
          id: "a/z.excalidraw",
          name: "z.excalidraw",
          kind: "file",
          parentId: "a",
          modifiedAt: 20,
          size: 2,
        },
      ],
      openFileId: null,
      dirtyById: {},
    });
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "a/a.excalidraw",
      name: "a.excalidraw",
      kind: "file",
      parentId: "a",
      modifiedAt: 30,
      size: 2,
    });

    const ok = await useStore.getState().renameEntry("a/z.excalidraw", "a");

    expect(ok).toBe(true);
    expect(useStore.getState().entries.map((e) => e.id)).toEqual([
      "a/a.excalidraw",
      "a/b.excalidraw",
    ]);
  });

  it("renameEntry renames the folder entry itself while remapping descendants", async () => {
    registerSession(true);
    useStore.setState({
      entries: [
        {
          id: "folder",
          name: "folder",
          kind: "directory",
          parentId: null,
          modifiedAt: 10,
          size: 0,
        },
        {
          id: "folder/old.excalidraw",
          name: "old.excalidraw",
          kind: "file",
          parentId: "folder",
          modifiedAt: 20,
          size: 5,
        },
      ],
    });
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "renamed",
      name: "renamed",
      kind: "directory",
      parentId: null,
      modifiedAt: 30,
      size: 0,
    });

    const ok = await useStore.getState().renameEntry("folder", "renamed");

    expect(ok).toBe(true);
    expect(useStore.getState().entries).toEqual([
      {
        id: "renamed",
        name: "renamed",
        kind: "directory",
        parentId: null,
        modifiedAt: 30,
        size: 0,
      },
      {
        id: "renamed/old.excalidraw",
        name: "old.excalidraw",
        kind: "file",
        parentId: "renamed",
        modifiedAt: 20,
        size: 5,
      },
    ]);
  });

  it("deleteEntry returns true on success", async () => {
    const ok = await useStore.getState().deleteEntry("file-2", "trash");

    expect(ok).toBe(true);
    expect(window.api.files.delete).toHaveBeenCalledWith("file-2", "trash");
    expect(window.api.files.list).not.toHaveBeenCalled();
    expect(useStore.getState().entries.some((e) => e.id === "file-2")).toBe(false);
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
    vi.mocked(window.api.settings.update).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      theme: "dark",
    });

    await useStore.getState().updateSettings({ theme: "dark" });

    expect(window.api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    // oxlint-disable-next-line typescript/unbound-method -- localStorage methods keep `this` through the member call
    expect(window.localStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(useStore.getState().settings.theme).toBe("dark");

    vi.mocked(window.api.settings.get).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "light" });

    await useStore.getState().initSettings();

    expect(useStore.getState().settings.theme).toBe("light");
    // oxlint-disable-next-line typescript/unbound-method -- localStorage methods keep `this` through the member call
    expect(window.localStorage.setItem).toHaveBeenLastCalledWith(THEME_STORAGE_KEY, "light");
  });
});

describe("overwriteOpenFileFromSession", () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ entries: mockEntries, openFileId: "file-1" });
  });

  it("persists through the active session", async () => {
    const saveNow = vi.fn(async () => true);
    sessionOwner.setActiveForTest({
      ensureCleanOrConfirm: async () => true,
      getSerializedContent: () => "{}",
      saveNow,
    } as unknown as BoundDrawingSession);

    await expect(useStore.getState().overwriteOpenFileFromSession()).resolves.toBe(true);
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(useStore.getState().error).toBeNull();
  });

  it("surfaces an error when the session write fails", async () => {
    const saveNow = vi.fn(async () => false);
    sessionOwner.setActiveForTest({
      ensureCleanOrConfirm: async () => true,
      getSerializedContent: () => "{}",
      saveNow,
    } as unknown as BoundDrawingSession);

    await expect(useStore.getState().overwriteOpenFileFromSession()).resolves.toBe(false);
    expect(useStore.getState().error?.operation).toBe("save");
  });

  it("is a no-op without an active session", async () => {
    await expect(useStore.getState().overwriteOpenFileFromSession()).resolves.toBe(false);
    expect(useStore.getState().error).toBeNull();
  });
});

describe("ensureCleanOrConfirm without a session", () => {
  beforeEach(() => {
    resetStore();
  });

  it("blocks when the open file is dirty", async () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { "file-1": true },
    });

    await expect(useStore.getState().ensureCleanOrConfirm("switch")).resolves.toBe(false);
  });

  it("allows switching when only unrelated keys are marked dirty", async () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-1",
      dirtyById: { ghost: true },
    });

    await expect(useStore.getState().ensureCleanOrConfirm("switch")).resolves.toBe(true);
  });
});

describe("createEntry", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      api: {
        store: { set: vi.fn(), get: vi.fn() },
        files: {
          create: vi.fn(),
          rename: vi.fn(),
          delete: vi.fn(),
          write: vi.fn(),
          writeRecover: vi.fn(),
          list: vi.fn(),
        },
        dialog: {
          unsavedChanges: vi.fn(),
          fileRecover: vi.fn(),
          fileChanged: vi.fn(),
        },
      },
    });
    resetStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the new id and inserts the returned entry sorted", async () => {
    useStore.setState({ entries: mockEntries });
    const created: FileEntry = {
      id: "dir-1/m.excalidraw",
      name: "m.excalidraw",
      kind: "file",
      parentId: "dir-1",
      modifiedAt: 400,
      size: 10,
    };
    vi.mocked(window.api.files.create).mockResolvedValue(created);

    const id = await useStore.getState().createEntry("dir-1", "file");

    expect(id).toBe("dir-1/m.excalidraw");
    expect(window.api.files.create).toHaveBeenCalledWith(
      "dir-1",
      expect.stringMatching(/^Untitled-\d{4}-\d{2}-\d{2}-\d{4}\.excalidraw$/),
      "file",
    );
    const ids = useStore.getState().entries.map((e) => e.id);
    expect(ids).toContain("dir-1/m.excalidraw");
  });

  it("propagates failures to the caller", async () => {
    useStore.setState({ entries: mockEntries });
    vi.mocked(window.api.files.create).mockRejectedValue(
      new Error("A file or folder with that name already exists"),
    );

    await expect(useStore.getState().createEntry(null, "directory")).rejects.toThrow(
      "already exists",
    );
    expect(useStore.getState().entries).toHaveLength(mockEntries.length);
  });
});

describe("recentFileIds", () => {
  const snapshotOf = (lastOpenedFileId: string | null): DrawingsSnapshot => ({
    info: { path: null, displayName: null, configured: false, missing: false },
    entries: mockEntries,
    prefs: { lastOpenedFileId },
  });

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves an opened drawing to the head and persists a stringified payload", async () => {
    useStore.setState({
      entries: mockEntries,
      openFileId: "file-2",
      recentFileIds: ["file-2", "dir-1"],
    });

    await useStore.getState().setOpenFileId("file-1");

    expect(useStore.getState().recentFileIds).toEqual(["file-1", "file-2", "dir-1"]);
    expect(window.api.store.set).toHaveBeenCalledWith(
      "recentFileIds",
      JSON.stringify(["file-1", "file-2", "dir-1"]),
    );
  });

  it("leaves recency untouched when the switch is cancelled", async () => {
    registerSession(false);
    useStore.setState({ entries: mockEntries, openFileId: "file-1" });
    useStore.setState({ recentFileIds: ["file-1"] });

    await useStore.getState().setOpenFileId("file-2");

    expect(useStore.getState().openFileId).toBe("file-1");
    expect(useStore.getState().recentFileIds).toEqual(["file-1"]);
    expect(window.api.store.set).not.toHaveBeenCalledWith("recentFileIds", expect.anything());
  });

  it("rewrites nested ids when a folder is renamed and persists the change", async () => {
    useStore.setState({
      entries: [
        {
          id: "folder",
          name: "folder",
          kind: "directory",
          parentId: null,
          modifiedAt: 10,
          size: 0,
        },
        {
          id: "folder/old.excalidraw",
          name: "old.excalidraw",
          kind: "file",
          parentId: "folder",
          modifiedAt: 20,
          size: 5,
        },
        mockEntries[0],
      ],
      recentFileIds: ["folder/old.excalidraw", "file-1"],
    });
    vi.mocked(window.api.files.rename).mockResolvedValue({
      id: "renamed",
      name: "renamed",
      kind: "directory",
      parentId: null,
      modifiedAt: 30,
      size: 0,
    });

    const ok = await useStore.getState().renameEntry("folder", "renamed");

    expect(ok).toBe(true);
    expect(useStore.getState().recentFileIds).toEqual(["renamed/old.excalidraw", "file-1"]);
    expect(window.api.store.set).toHaveBeenCalledWith(
      "recentFileIds",
      JSON.stringify(["renamed/old.excalidraw", "file-1"]),
    );
  });

  it("prunes ids inside a deleted folder and persists the change", async () => {
    useStore.setState({
      entries: [
        {
          id: "dir-1",
          name: "subfolder",
          kind: "directory",
          parentId: null,
          modifiedAt: 300,
          size: 0,
        },
        ...mockEntries.filter((e) => e.id !== "dir-1"),
      ],
      recentFileIds: ["file-1", "dir-1/file-x", "file-2"],
    });
    vi.mocked(window.api.files.delete).mockResolvedValue(undefined);

    const ok = await useStore.getState().deleteEntry("dir-1", "trash");

    expect(ok).toBe(true);
    expect(useStore.getState().recentFileIds).toEqual(["file-1", "file-2"]);
    expect(window.api.store.set).toHaveBeenCalledWith(
      "recentFileIds",
      JSON.stringify(["file-1", "file-2"]),
    );
  });

  it("boot hydration drops vanished ids and keeps surviving order", () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, reopenLastDrawing: true } });

    useStore
      .getState()
      .loadSnapshot(snapshotOf("file-2"), JSON.stringify(["gone", "dir-1", "file-1", "file-2"]));

    expect(useStore.getState().recentFileIds).toEqual(["file-1", "file-2"]);
    expect(useStore.getState().openFileId).toBe("file-2");
  });

  it("boot hydration seeds from the restored open file when nothing survives", () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, reopenLastDrawing: true } });

    useStore.getState().loadSnapshot(snapshotOf("file-1"), JSON.stringify(["vanished"]));

    expect(useStore.getState().recentFileIds).toEqual(["file-1"]);

    useStore.getState().loadSnapshot(snapshotOf(null), null);

    expect(useStore.getState().recentFileIds).toEqual([]);
    expect(useStore.getState().openFileId).toBeNull();
  });
});
