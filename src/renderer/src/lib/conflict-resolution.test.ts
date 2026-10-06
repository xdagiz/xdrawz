import { sortFileEntries, type FileEntry } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConflictSlice } from "./conflict-resolution";
import { type ExternalConflict } from "./conflicts";

const handshake = { active: false };
const session = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/session-owner", () => ({
  sessionOwner: session,
}));

vi.mock("@/lib/close-handshake", () => ({
  isCloseHandshakeActive: () => handshake.active,
}));

const changedAt = (diskModifiedAt: number): ExternalConflict => ({
  type: "changed",
  fileId: "a.excalidraw",
  diskModifiedAt,
});

const missingConflict = (): ExternalConflict => ({
  type: "missing",
  fileId: "a.excalidraw",
});

const makeHarness = async (overrides: Partial<ConflictSlice> = {}) => {
  const slice: ConflictSlice = {
    entries: [],
    rootPath: "/drawings",
    editorGeneration: 1,
    openFileId: "a.excalidraw",
    dirtyById: { "a.excalidraw": true },
    rawDirtyById: { "a.excalidraw": true },
    error: null,
    externalConflict: null,
    ...overrides,
  };

  const dialog = { fileChanged: vi.fn(), fileRecover: vi.fn() };
  const files = { writeRecover: vi.fn(), list: vi.fn() };
  vi.stubGlobal("window", { api: { dialog, files } });

  const calls = { reload: vi.fn(), discard: vi.fn() };

  const mod = await import("./conflict-resolution");
  const resolver = mod.createConflictResolver({
    get: () => ({ ...slice }),
    set: (patch) => Object.assign(slice, patch),
    reloadOpenFileFromDisk: calls.reload,
    discardMissingOpenFile: calls.discard,
    commitEntries: sortFileEntries,
  });

  const dismissChanged = async () => {
    dialog.fileChanged.mockResolvedValue("cancel");
    await resolver.resolveChangedConflict();
    dialog.fileChanged.mockClear();
  };

  const dismissMissing = async () => {
    dialog.fileRecover.mockResolvedValue("cancel");
    await resolver.resolveMissingConflict();
    dialog.fileRecover.mockClear();
  };

  return { slice, dialog, files, calls, resolver, dismissChanged, dismissMissing };
};

afterEach(() => {
  handshake.active = false;
  session.getSession.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("resolveChangedConflict", () => {
  it("cancels without a dialog when no changed conflict exists", async () => {
    const { dialog, resolver } = await makeHarness();

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).not.toHaveBeenCalled();
  });

  it("cancels on a dismissed key unless forced", async () => {
    const conflict = changedAt(200);
    const { dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: conflict,
    });
    await dismissChanged();

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).not.toHaveBeenCalled();

    dialog.fileChanged.mockResolvedValue("overwrite");
    expect(await resolver.resolveChangedConflict({ force: true })).toBe("overwrite");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("reloads on choice and clears the dismissal", async () => {
    const conflict = changedAt(200);
    const { dialog, calls, resolver, dismissChanged } = await makeHarness({
      externalConflict: conflict,
    });
    await dismissChanged();
    dialog.fileChanged.mockResolvedValue("reload");

    expect(await resolver.resolveChangedConflict({ force: true })).toBe("reload");
    expect(calls.reload).toHaveBeenCalledTimes(1);
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);

    dialog.fileChanged.mockResolvedValue("cancel");
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(2);
  });

  it("clears the conflict on overwrite", async () => {
    const conflict = changedAt(200);
    const { dialog, slice, resolver, dismissChanged } = await makeHarness({
      externalConflict: conflict,
    });
    await dismissChanged();
    dialog.fileChanged.mockResolvedValue("overwrite");

    expect(await resolver.resolveChangedConflict({ force: true })).toBe("overwrite");
    expect(slice.externalConflict).toBeNull();
  });

  it("records the dismissal on cancel", async () => {
    const conflict = changedAt(200);
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: conflict,
    });
    dialog.fileChanged.mockResolvedValue("cancel");

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(slice.externalConflict).toEqual(conflict);

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent dialogs into one prompt with one outcome", async () => {
    const conflict = changedAt(200);
    const { dialog, resolver } = await makeHarness({ externalConflict: conflict });

    let release!: (choice: "reload") => void;
    dialog.fileChanged.mockImplementation(
      () =>
        new Promise<"reload">((resolve) => {
          release = resolve;
        }),
    );

    const first = resolver.resolveChangedConflict();
    const second = resolver.resolveChangedConflict();
    release("reload");

    expect(await first).toBe("reload");
    expect(await second).toBe("reload");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale choice when the disk version changes mid-dialog", async () => {
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: changedAt(200),
    });

    let release!: (choice: "overwrite") => void;
    dialog.fileChanged.mockImplementation(
      () =>
        new Promise<"overwrite">((resolve) => {
          release = resolve;
        }),
    );

    const pending = resolver.resolveChangedConflict();
    slice.externalConflict = changedAt(500);
    release("overwrite");

    expect(await pending).toBe("cancel");
    expect(slice.externalConflict).toEqual(changedAt(500));

    dialog.fileChanged.mockResolvedValue("reload");
    expect(await resolver.resolveChangedConflict()).toBe("reload");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(2);
  });
});

describe("resolveMissingConflict", () => {
  const missing: ExternalConflict = { type: "missing", fileId: "a.excalidraw" };

  it("recovers supplied content and upserts the returned entry without listing files", async () => {
    const { dialog, files, slice, resolver } = await makeHarness({
      externalConflict: missing,
      dirtyById: {},
    });
    dialog.fileRecover.mockResolvedValue("recover");
    const entry: FileEntry = {
      id: "a.excalidraw",
      name: "a.excalidraw",
      kind: "file",
      parentId: null,
      modifiedAt: 300,
      size: 100,
      ino: "1",
      dev: "1",
    };
    files.writeRecover.mockResolvedValue(entry);

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("recover");
    expect(files.writeRecover).toHaveBeenCalledWith("a.excalidraw", "<json/>");
    expect(slice.externalConflict).toBeNull();
    expect(slice.error).toBeNull();
    expect(slice.entries).toEqual([entry]);
    expect(files.list).not.toHaveBeenCalled();
  });

  it("discards via the dependency and clears the dismissal", async () => {
    const { dialog, calls, resolver, dismissMissing } = await makeHarness({
      externalConflict: missing,
    });
    await dismissMissing();
    dialog.fileRecover.mockResolvedValue("discard");

    expect(await resolver.resolveMissingConflict("<json/>", { force: true })).toBe("discard");
    expect(calls.discard).toHaveBeenCalledTimes(1);
    expect(dialog.fileRecover).toHaveBeenCalledTimes(1);
  });

  it("dismisses the key on cancel", async () => {
    const { dialog, resolver } = await makeHarness({
      externalConflict: missing,
    });
    dialog.fileRecover.mockResolvedValue("cancel");

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("cancel");

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("cancel");
    expect(dialog.fileRecover).toHaveBeenCalledTimes(1);
  });

  it("fails softly when there is nothing to recover", async () => {
    const { slice, resolver } = await makeHarness({
      externalConflict: missing,
    });

    expect(await resolver.resolveMissingConflict()).toBe("cancel");
    expect(slice.error).not.toBeNull();
  });

  it("ignores a stale choice when the conflict changes mid-dialog", async () => {
    const { dialog, files, slice, resolver } = await makeHarness({
      externalConflict: missing,
    });
    let release!: (choice: "recover") => void;
    dialog.fileRecover.mockImplementation(
      () =>
        new Promise<"recover">((resolve) => {
          release = resolve;
        }),
    );
    const pending = resolver.resolveMissingConflict("<json/>");
    slice.externalConflict = { type: "missing", fileId: "b.excalidraw" };
    release("recover");

    expect(await pending).toBe("cancel");
    expect(slice.externalConflict).toEqual({ type: "missing", fileId: "b.excalidraw" });
    expect(files.writeRecover).not.toHaveBeenCalled();
  });
});

describe("gateConflictedSave", () => {
  it("proceeds when no conflict exists for the file", async () => {
    const { resolver } = await makeHarness();

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "auto")).toEqual({
      action: "proceed",
    });
  });

  it("stops autosave while a conflict exists on the file", async () => {
    const { dialog, resolver } = await makeHarness({
      externalConflict: changedAt(200),
    });

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "auto")).toEqual({
      action: "stop",
      result: false,
    });
    expect(dialog.fileChanged).not.toHaveBeenCalled();
  });

  it("forces the overwrite dialog for explicit saves against a changed file", async () => {
    const { dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();
    dialog.fileChanged.mockResolvedValue("overwrite");

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "explicit")).toEqual({
      action: "proceed",
    });
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("blocks saves during the close handshake and clears the dismissal", async () => {
    handshake.active = true;
    const { dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "explicit")).toEqual({
      action: "stop",
      result: false,
    });
    expect(dialog.fileChanged).not.toHaveBeenCalled();

    handshake.active = false;
    dialog.fileChanged.mockResolvedValue("cancel");
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("reports failure when recovery of a missing explicit save is cancelled", async () => {
    const { dialog, resolver } = await makeHarness({
      externalConflict: missingConflict(),
    });
    dialog.fileRecover.mockResolvedValue("cancel");

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "explicit")).toEqual({
      action: "stop",
      result: false,
    });
  });
});

describe("recoverMissingOpenFile", () => {
  it("fails softly when the session has no serialized content", async () => {
    const { slice, resolver } = await makeHarness({
      externalConflict: { type: "missing", fileId: "a.excalidraw" },
    });

    expect(await resolver.recoverMissingOpenFile()).toBe(false);
    expect(slice.error).not.toBeNull();
  });
});

describe("resetConflicts", () => {
  it("clears the active conflict and the dismissal", async () => {
    const { dialog, slice, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();

    resolver.resetConflicts();

    expect(slice.externalConflict).toBeNull();

    slice.externalConflict = changedAt(200);
    dialog.fileChanged.mockResolvedValue("cancel");
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });
});

describe("clearDismissalIfOwned", () => {
  it("clears a dismissal belonging to the file and reports ownership", async () => {
    const { slice, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();
    slice.externalConflict = null;

    expect(resolver.clearDismissalIfOwned("a.excalidraw")).toBe(true);
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
  });

  it("returns false when the dismissal belongs to another file", async () => {
    const { slice, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();
    slice.externalConflict = null;

    expect(resolver.clearDismissalIfOwned("b.excalidraw")).toBe(false);
  });
});

describe("syncDismissal", () => {
  it("keeps the dismissal when the same conflict key recurs", async () => {
    const conflict = changedAt(200);
    const { dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: conflict,
    });
    await dismissChanged();

    resolver.syncDismissal(changedAt(200));

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).not.toHaveBeenCalled();
  });

  it("clears the dismissal when the conflict key changes", async () => {
    const { dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();

    resolver.syncDismissal(changedAt(500));

    dialog.fileChanged.mockResolvedValue("cancel");
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("clears the dismissal when the conflict resolves", async () => {
    const { slice, dialog, resolver, dismissChanged } = await makeHarness({
      externalConflict: changedAt(200),
    });
    await dismissChanged();

    resolver.syncDismissal(null);

    slice.externalConflict = changedAt(200);
    dialog.fileChanged.mockResolvedValue("cancel");
    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });
});
