import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createSwitcherController,
  type SwitcherControllerDeps,
  type SwitcherState,
} from "./switcher-controller";

const harness = (overrides: Partial<SwitcherControllerDeps> = {}) => {
  const states: SwitcherState[] = [];
  const committed: string[] = [];
  let candidates = ["a", "b", "c"];

  const deps: SwitcherControllerDeps = {
    getCandidates: () => candidates,
    canSwitchNow: () => true,
    commit: (fileId) => committed.push(fileId),
    onChange: (state) => states.push(state),
    ...overrides,
  };

  const controller = createSwitcherController(deps);

  return {
    controller,
    states,
    committed,
    setCandidates: (next: string[]) => {
      candidates = next;
    },
    lastState: () => states[states.length - 1] ?? ({ phase: "idle" } satisfies SwitcherState),
  };
};

describe("switcher-controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start opens cycling with the previous drawing highlighted", () => {
    const h = harness();
    h.controller.start();

    expect(h.lastState()).toEqual({ phase: "cycling", index: 1 });
    expect(h.committed).toEqual([]);
  });

  it("start stays idle with fewer than two candidates", () => {
    const h = harness({ getCandidates: () => ["only"] });
    h.controller.start();

    expect(h.lastState()).toEqual({ phase: "idle" });
  });

  it("the guard flag blocks start", () => {
    let blocked = true;
    const h = harness({ canSwitchNow: () => !blocked });
    h.controller.start();
    expect(h.lastState()).toEqual({ phase: "idle" });

    blocked = false;
    h.controller.start();
    expect(h.lastState()).toEqual({ phase: "cycling", index: 1 });
  });

  it("stepping wraps in both directions", () => {
    const h = harness();
    h.controller.start();

    h.controller.step(1);
    expect(h.lastState()).toEqual({ phase: "cycling", index: 2 });

    h.controller.step(1);
    expect(h.lastState()).toEqual({ phase: "cycling", index: 0 });

    h.controller.step(-1);
    expect(h.lastState()).toEqual({ phase: "cycling", index: 2 });
  });

  it("repeated start while cycling acts as step(1)", () => {
    const h = harness();
    h.controller.start();
    h.controller.start();

    expect(h.lastState()).toEqual({ phase: "cycling", index: 2 });
  });

  it("commit dispatches the highlighted id, returns to idle first, and clears timers", () => {
    const order: string[] = [];
    const h = harness({
      commit: (id) => order.push(`commit:${id}`),
      onChange: (state) => order.push(`change:${state.phase}`),
    });
    h.controller.start();
    h.controller.commit();

    expect(order).toEqual(["change:cycling", "change:idle", "commit:b"]);

    vi.advanceTimersByTime(2000);
    expect(order).toEqual(["change:cycling", "change:idle", "commit:b"]);
  });

  it("the fallback timer commits after the quiet period", () => {
    const h = harness();
    h.controller.start();

    vi.advanceTimersByTime(599);
    expect(h.committed).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(h.committed).toEqual(["b"]);
    expect(h.lastState()).toEqual({ phase: "idle" });
  });

  it("the fallback stands down while a combo key is held, then commits once allowed", () => {
    let allow = false;
    const h = harness({ canAutoCommit: () => allow });
    h.controller.start();

    vi.advanceTimersByTime(1800);
    expect(h.committed).toEqual([]);
    expect(h.lastState()).toEqual({ phase: "cycling", index: 1 });

    allow = true;
    vi.advanceTimersByTime(600);
    expect(h.committed).toEqual(["b"]);
  });

  it("stepping re-arms the fallback timer", () => {
    const h = harness();
    h.controller.start();

    vi.advanceTimersByTime(500);
    h.controller.step(1);

    vi.advanceTimersByTime(500);
    expect(h.committed).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(h.committed).toEqual(["c"]);
  });

  it("step while idle is a no-op", () => {
    const h = harness();
    h.controller.step(-1);
    h.controller.step(1);

    expect(h.states).toEqual([]);
    expect(h.lastState()).toEqual({ phase: "idle" });
  });

  it("candidates shrinking to one mid-cycle cancels instead of crashing", () => {
    const h = harness();
    h.controller.start();
    h.setCandidates(["a"]);

    h.controller.step(1);

    expect(h.lastState()).toEqual({ phase: "idle" });
  });

  it("commitAt clamps the tile index and routes through commit", () => {
    const h = harness();
    h.controller.start();
    h.controller.commitAt(9);

    expect(h.committed).toEqual(["c"]);

    h.controller.start();
    h.controller.commitAt(-3);
    expect(h.committed).toEqual(["c", "a"]);
  });
});
