import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, AppState } from "@excalidraw/excalidraw/types";
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (_elements: unknown, appState: { viewBackgroundColor?: string }) =>
    JSON.stringify({ scene: true, vbg: appState?.viewBackgroundColor }),
}));

import {
  AUTOSAVE_MS,
  createDrawingSession,
  drawingSignature,
  MAX_SAVE_RETRIES,
} from "./drawing-session";

const el = (id: string) => ({ id, type: "rectangle" }) as unknown as OrderedExcalidrawElement;

const appState = (
  vbg = "#ffffff",
  grid?: Partial<Pick<AppState, "gridSize" | "gridStep" | "gridModeEnabled">>,
): AppState => ({ isLoading: false, viewBackgroundColor: vbg, ...grid }) as unknown as AppState;

const emptyFiles = {} as BinaryFiles;

type Session = ReturnType<typeof createDrawingSession>;

const makeSession = (overrides?: {
  save?: (id: string, content: string) => Promise<boolean>;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  initialBaseline?: string | null;
}): { session: Session; dirty: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } => {
  const dirty = vi.fn();
  const save = overrides?.save ? vi.fn(overrides.save) : vi.fn().mockResolvedValue(true);
  const session = createDrawingSession({
    fileId: "f1",
    save,
    onDirtyChange: overrides?.onDirtyChange ?? dirty,
    initialBaseline: overrides?.initialBaseline,
  });
  return { session, dirty, save };
};

describe("createDrawingSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("establishes baseline on the first post-load onChange", () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("marks dirty and autosaves on user changes after the baseline", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
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
    const { session, dirty } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a")], appState("#ffffff", { gridModeEnabled: true }), emptyFiles);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    session.onChange([el("a")], appState(), emptyFiles);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("marks dirty until it persists when the first commit differs from the disk baseline", async () => {
    const diskBaseline = drawingSignature([el("raw")], appState("#000000"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: diskBaseline });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("f1", expect.any(String), "auto");
  });

  it("does not write when the first commit matches the disk baseline", async () => {
    const sig = drawingSignature([el("a")], appState("#ffffff"), emptyFiles);
    const { session, dirty, save } = makeSession({ initialBaseline: sig });

    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("applies setInitialBaseline before the first commit", async () => {
    const { session, dirty, save } = makeSession();

    vi.advanceTimersByTime(150);
    session.setInitialBaseline("disk-version");
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).toHaveBeenCalledWith("f1", true);
    expect(save).toHaveBeenCalledTimes(1);
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

  it("force flush writes while autosave is paused (the Save path during the dialog)", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    session.setAutosavePaused(true);
    await session.flush({ force: true });

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("saveNow persists the latest drawing immediately", async () => {
    const { session, dirty, save } = makeSession({
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);
    expect(dirty).toHaveBeenCalledWith("f1", true);

    const saved = await session.saveNow();

    expect(saved).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("saveNow refuses to write when no scene was ever loaded from disk", async () => {
    const { session, dirty, save } = makeSession();

    // A placeholder scene (e.g. the empty canvas Excalidraw mounts when a load
    // fails) can reach onChange without a disk baseline ever being established.
    session.onChange([el("a")], appState(), emptyFiles);

    const saved = await session.saveNow();

    expect(saved).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
  });

  it("saveNow reports a failed persistence as false", async () => {
    const save = vi.fn().mockResolvedValue(false);
    const { session } = makeSession({
      save,
      initialBaseline: drawingSignature([el("a")], appState(), emptyFiles),
    });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    const saved = await session.saveNow();

    expect(saved).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("resetBaseline lets a later load re-establish the baseline without a spurious save", async () => {
    const diskBaseline = drawingSignature([el("a")], appState("#ffffff"), emptyFiles);
    const { session, dirty, save } = makeSession();

    // Failed load: a placeholder scene captures the baseline (no disk baseline
    // exists yet), then the editor clears it so the next successful load takes
    // over instead of being ignored.
    session.onChange([el("x")], appState("#000000"), emptyFiles);
    expect(save).not.toHaveBeenCalled();

    session.resetBaseline();
    session.setInitialBaseline(diskBaseline);
    session.onChange([el("a")], appState("#ffffff"), emptyFiles);

    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
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

  it("flush persists immediately without force when dirty", async () => {
    const { session, dirty, save } = makeSession();

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    await session.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("persists a return to the baseline after an older save is already in flight", async () => {
    let resolveFirstSave!: (ok: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    const { session, dirty } = makeSession({ save });

    session.onChange([el("a")], appState("#000000"), emptyFiles);
    session.onChange([el("a"), el("b")], appState("#ffffff"), emptyFiles);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(1);

    // Reverting while the first write is unresolved must queue the final state.
    session.onChange([el("a")], appState("#000000"), emptyFiles);
    resolveFirstSave(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("f1", expect.stringContaining('"vbg":"#000000"'), "auto");
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("retries a failed save after AUTOSAVE_MS", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { session, dirty } = makeSession({ save });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenLastCalledWith("f1", true);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(dirty).toHaveBeenLastCalledWith("f1", false);
  });

  it("stops retrying after MAX_SAVE_RETRIES consecutive failures", async () => {
    const save = vi.fn().mockResolvedValue(false);
    const { session } = makeSession({ save });

    session.onChange([el("a")], appState(), emptyFiles);
    session.onChange([el("a"), el("b")], appState(), emptyFiles);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);

    for (let i = 0; i < MAX_SAVE_RETRIES + 1; i++) {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    }

    expect(save).toHaveBeenCalledTimes(1 + MAX_SAVE_RETRIES);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 100);
    expect(save).toHaveBeenCalledTimes(1 + MAX_SAVE_RETRIES);
  });
});
