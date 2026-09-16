import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(), close: vi.fn() } }));

import { useStore } from "./store";

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  vi.stubGlobal("window", { api: { store: { set: vi.fn() } } });
});

afterEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scratch unsaved lifecycle", () => {
  it("does not clear captured work just because creation stops", () => {
    useStore.getState().setScratchUnsaved(true);
    useStore.getState().setPendingCanvasAction(false);
    expect(useStore.getState().scratchUnsaved).toBe(true);
  });
});
