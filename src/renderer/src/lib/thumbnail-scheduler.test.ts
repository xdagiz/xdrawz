import { describe, expect, it, vi } from "vite-plus/test";

import { createSlotPump, type IdleDeadline } from "./thumbnail-scheduler";

describe("createSlotPump", () => {
  it("schedules exactly one slot per kick while pending", () => {
    const requestSlot = vi.fn((cb: (deadline: IdleDeadline) => void) => {
      void cb;
      return () => {};
    });
    const drain = vi.fn();
    const pump = createSlotPump({ drain, requestSlot });

    pump.kick();
    pump.kick();
    pump.kick();

    expect(requestSlot).toHaveBeenCalledTimes(1);
  });

  it("delivers the deadline to drain and allows re-kick after firing", () => {
    let captured: ((deadline: IdleDeadline) => void) | undefined;
    const requestSlot = vi.fn((cb: (deadline: IdleDeadline) => void) => {
      captured = cb;
      return () => {};
    });
    const drain = vi.fn();
    const pump = createSlotPump({ drain, requestSlot });

    pump.kick();
    captured?.({ timeRemaining: () => 7 });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.calls[0]?.[0]?.timeRemaining()).toBe(7);

    pump.kick();
    expect(requestSlot).toHaveBeenCalledTimes(2);
  });

  it("cancel prevents the pending slot from firing", () => {
    let cancelFn: (() => void) | undefined;
    const requestSlot = vi.fn(() => {
      cancelFn = vi.fn();
      return cancelFn;
    });
    const drain = vi.fn();
    const pump = createSlotPump({ drain, requestSlot });

    pump.kick();
    pump.cancel();
    expect(cancelFn).toHaveBeenCalled();

    pump.kick();
    (cancelFn as unknown as undefined) = undefined;
    expect(drain).not.toHaveBeenCalled();
  });

  it("re-kick after cancel schedules a fresh slot", () => {
    const cancels: Array<() => void> = [];
    const requestSlot = vi.fn(() => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return cancel;
    });
    const drain = vi.fn();
    const pump = createSlotPump({ drain, requestSlot });

    pump.kick();
    pump.cancel();
    pump.kick();
    expect(requestSlot).toHaveBeenCalledTimes(2);

    cancels[1]?.();
    expect(drain).not.toHaveBeenCalled();
  });

  it("default requester drains via setTimeout fallback with zero deadline", async () => {
    vi.useFakeTimers();
    const drain = vi.fn();
    const pump = createSlotPump({ drain });

    pump.kick();
    await vi.advanceTimersByTimeAsync(20);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.calls[0]?.[0]?.timeRemaining()).toBe(0);
    vi.useRealTimers();
  });
});
