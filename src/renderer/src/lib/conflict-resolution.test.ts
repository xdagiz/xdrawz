import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConflictSlice } from "./conflict-resolution";
import { conflictKeyOf, type ExternalConflict } from "./conflicts";

const handshake = { active: false };

vi.mock("@/lib/session-owner", () => ({
  sessionOwner: { getSession: () => null },
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
    openFileId: "a.excalidraw",
    dirtyById: { "a.excalidraw": true },
    error: null,
    externalConflict: null,
    dismissedConflictKey: null,
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
  });

  return { slice, dialog, files, calls, resolver };
};

afterEach(() => {
  handshake.active = false;
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
    const { dialog, resolver } = await makeHarness({
      externalConflict: conflict,
      dismissedConflictKey: conflictKeyOf(conflict as NonNullable<ExternalConflict>),
    });

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(dialog.fileChanged).not.toHaveBeenCalled();

    dialog.fileChanged.mockResolvedValue("overwrite");
    expect(await resolver.resolveChangedConflict({ force: true })).toBe("overwrite");
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("reloads on choice and clears the dismissed key", async () => {
    const conflict = changedAt(200);
    const { dialog, calls, slice, resolver } = await makeHarness({
      externalConflict: conflict,
      dismissedConflictKey: conflictKeyOf(conflict as NonNullable<ExternalConflict>),
    });
    dialog.fileChanged.mockResolvedValue("reload");

    expect(await resolver.resolveChangedConflict({ force: true })).toBe("reload");
    expect(calls.reload).toHaveBeenCalledTimes(1);
    expect(slice.dismissedConflictKey).toBeNull();
  });

  it("clears the conflict on overwrite", async () => {
    const conflict = changedAt(200);
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: conflict,
      dismissedConflictKey: conflictKeyOf(conflict as NonNullable<ExternalConflict>),
    });
    dialog.fileChanged.mockResolvedValue("overwrite");

    expect(await resolver.resolveChangedConflict({ force: true })).toBe("overwrite");
    expect(slice.externalConflict).toBeNull();
    expect(slice.dismissedConflictKey).toBeNull();
  });

  it("records the dismissal on cancel", async () => {
    const conflict = changedAt(200);
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: conflict,
    });
    dialog.fileChanged.mockResolvedValue("cancel");

    expect(await resolver.resolveChangedConflict()).toBe("cancel");
    expect(slice.dismissedConflictKey).toBe(
      conflictKeyOf(conflict as NonNullable<ExternalConflict>),
    );
    expect(slice.externalConflict).toEqual(conflict);
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
});

describe("resolveMissingConflict", () => {
  const missing: ExternalConflict = { type: "missing", fileId: "a.excalidraw" };

  it("recovers stored content through writeRecover and refreshes entries", async () => {
    const { dialog, files, slice, resolver } = await makeHarness({
      externalConflict: missing,
      dirtyById: {},
    });
    dialog.fileRecover.mockResolvedValue("recover");
    files.writeRecover.mockResolvedValue({});
    files.list.mockResolvedValue([]);

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("recover");
    expect(files.writeRecover).toHaveBeenCalledWith("a.excalidraw", "<json/>");
    expect(slice.externalConflict).toBeNull();
    expect(slice.error).toBeNull();
  });

  it("discards via the dependency and clears the dismissed key", async () => {
    const { dialog, calls, slice, resolver } = await makeHarness({
      externalConflict: missing,
    });
    dialog.fileRecover.mockResolvedValue("discard");

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("discard");
    expect(calls.discard).toHaveBeenCalledTimes(1);
    expect(slice.dismissedConflictKey).toBeNull();
  });

  it("dismisses the key on cancel", async () => {
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: missing,
    });
    dialog.fileRecover.mockResolvedValue("cancel");

    expect(await resolver.resolveMissingConflict("<json/>")).toBe("cancel");
    expect(slice.dismissedConflictKey).toBe(
      conflictKeyOf(missing as NonNullable<ExternalConflict>),
    );
  });

  it("fails softly when there is nothing to recover", async () => {
    const { slice, resolver } = await makeHarness({
      externalConflict: missing,
    });

    expect(await resolver.resolveMissingConflict()).toBe("cancel");
    expect(slice.error).not.toBeNull();
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
    const { dialog, resolver } = await makeHarness({
      externalConflict: changedAt(200),
      dismissedConflictKey: conflictKeyOf(changedAt(200) as NonNullable<ExternalConflict>),
    });
    dialog.fileChanged.mockResolvedValue("overwrite");

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "explicit")).toEqual({
      action: "proceed",
    });
    expect(dialog.fileChanged).toHaveBeenCalledTimes(1);
  });

  it("blocks saves during the close handshake", async () => {
    handshake.active = true;
    const { dialog, slice, resolver } = await makeHarness({
      externalConflict: changedAt(200),
      dismissedConflictKey: "changed:a.excalidraw:1",
    });

    expect(await resolver.gateConflictedSave("a.excalidraw", "<json/>", "explicit")).toEqual({
      action: "stop",
      result: false,
    });
    expect(slice.dismissedConflictKey).toBeNull();
    expect(dialog.fileChanged).not.toHaveBeenCalled();
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
