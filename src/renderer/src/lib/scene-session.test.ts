import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, AppState } from "@excalidraw/excalidraw/types";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (_elements: unknown, appState: { viewBackgroundColor?: string }) =>
    JSON.stringify({ scene: true, vbg: appState?.viewBackgroundColor }),
}));

import { AUTOSAVE_MS, createSceneSession, sceneSignature } from "./scene-session";

const el = (id: string) => ({ id, type: "rectangle" }) as unknown as OrderedExcalidrawElement;

const appState = (
  vbg = "#ffffff",
  grid?: Partial<Pick<AppState, "gridSize" | "gridStep" | "gridModeEnabled">>,
): AppState => ({ isLoading: false, viewBackgroundColor: vbg, ...grid }) as unknown as AppState;

const emptyFiles = {} as BinaryFiles;

type Session = ReturnType<typeof createSceneSession>;

const makeSession = (overrides?: {
  save?: (id: string, content: string) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  initialBaseline?: string | null;
}): { session: Session; dirty: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } => {
  const dirty = vi.fn();
  const save = overrides?.save ? vi.fn(overrides.save) : vi.fn().mockResolvedValue(true);
  const session = createSceneSession({
    fileId: "f1",
    save,
    onDirtyChange: overrides?.onDirtyChange ?? dirty,
    initialBaseline: overrides?.initialBaseline,
  });
  return { session, dirty, save };
};

describe("createSceneSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("establishes baseline on the first post-load onChange no matter when it lands", async () => {
    const { session, dirty, save } = makeSession();

    await vi.advanceTimersByTimeAsync(150);

    session.onChange([el("a")], appState(), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("skips identical subsequent commits after the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState(), emptyFiles);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("marks dirty and autosaves on user changes after the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(save).toHaveBeenCalledWith("f1", expect.any(String));
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("clears dirty when the user reverts to the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    session.onChange([el("a")], appState(), emptyFiles);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).not.toHaveBeenCalled();
  });

  it("marks dirty when only grid settings change (elements unchanged)", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState("#ffffff", { gridModeEnabled: true }), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("marks dirty when grid size or grid step change", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState("#ffffff", { gridSize: 40, gridStep: 40 }), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clears dirty when grid settings revert to the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState("#ffffff", { gridModeEnabled: true }), emptyFiles);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    session.onChange([el("a")], appState(), emptyFiles);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not save when the first commit matches a grid-bearing disk baseline", async () => {
    const sig = sceneSignature(
      [el("a")],
      appState("#ffffff", { gridModeEnabled: true, gridSize: 40 }),
      emptyFiles,
    );
    const { session, dirty, save } = makeSession({ initialBaseline: sig });

    session.onChange(
      [el("a")],
      appState("#ffffff", { gridModeEnabled: true, gridSize: 40 }),
      emptyFiles,
    );

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("quietly persists when the first commit differs from the disk baseline", async () => {
    const diskBaseline = sceneSignature([el("raw")], appState("#000000"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: diskBaseline });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("f1", expect.any(String));
  });

  it("does not write when the first commit matches the disk baseline", async () => {
    const sig = sceneSignature([el("a")], appState("#ffffff"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: sig });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("converges exactly once across repeated identical commits", async () => {
    const { session, dirty, save } = makeSession({ initialBaseline: "disk-version" });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("applies setInitialBaseline before the first commit", async () => {
    const { session, dirty, save } = makeSession();

    vi.advanceTimersByTime(150);
    session.setInitialBaseline("disk-version");
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores setInitialBaseline once the baseline is established", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    session.setInitialBaseline("disk-version");
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("defers autosave while blocked, then resumes it after a cancelled confirm", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const confirm = vi.fn().mockResolvedValue("cancel");
    const allowed = await session.ensureCleanOrConfirm("quit", confirm);

    expect(allowed).toBe(false);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("saveNow persists the latest scene immediately", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    await session.saveNow();

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("flush with force persists user changes during confirm", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const allowed = await session.ensureCleanOrConfirm("switch", vi.fn().mockResolvedValue("save"));

    expect(allowed).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("discard abandons changes and cleans the dirty flag", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    const allowed = await session.ensureCleanOrConfirm(
      "switch",
      vi.fn().mockResolvedValue("discard"),
    );

    expect(allowed).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("saveNow before any scene has loaded is a no-op", async () => {
    const { session, dirty, save } = makeSession();
    await session.saveNow();
    expect(save).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it("getSerializedContent returns the latest scene", () => {
    const { session } = makeSession({ save: vi.fn().mockResolvedValue(true) });
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);
    expect(session.getSerializedContent()).toBe(JSON.stringify({ scene: true, vbg: "#ffffff" }));
  });
});
