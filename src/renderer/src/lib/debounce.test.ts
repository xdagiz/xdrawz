import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";

import { debounceAsync } from "./debounce";

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("debounceAsync", () => {
  let fn: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let debounced: ReturnType<typeof debounceAsync<[]>>;

  beforeEach(() => {
    fn = vi.fn<() => Promise<void>>();
    fn.mockImplementation(async () => {});
    debounced = debounceAsync(fn, 100);
  });

  afterEach(() => {
    debounced.cancel();
    vi.restoreAllMocks();
  });

  describe("basic debounce", () => {
    it("calls fn after the wait period", async () => {
      debounced();
      expect(fn.mock.calls).toHaveLength(0);
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("calls fn only once for multiple rapid calls", async () => {
      debounced();
      debounced();
      debounced();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("passes the latest args to fn", async () => {
      const d = debounceAsync<[a: string, b: number]>(fn, 50);
      d("first", 1);
      d("second", 2);
      await tick(80);
      expect(fn.mock.calls).toHaveLength(1);
      expect(fn.mock.calls[0]).toEqual(["second", 2]);
      d.cancel();
    });

    it("does not call fn before the wait period", async () => {
      debounced();
      await tick(50); // half of 100ms
      expect(fn.mock.calls).toHaveLength(0);
    });
  });

  describe("cancel", () => {
    it("prevents pending invocation from firing", async () => {
      debounced();
      debounced.cancel();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("clears pending args so flush has nothing to write", async () => {
      debounced();
      debounced.cancel();
      await debounced.flush();
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("is safe to call multiple times", () => {
      debounced.cancel();
      debounced.cancel();
    });

    it("allows new calls after cancel", async () => {
      debounced();
      debounced.cancel();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(0);

      debounced();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });
  });

  describe("flush", () => {
    it("immediately invokes pending fn", async () => {
      debounced();
      await debounced.flush();
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("flushing with no pending call resolves without calling fn", async () => {
      await debounced.flush();
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("multiple flushes only call fn once", async () => {
      debounced();
      await debounced.flush();
      await debounced.flush();
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("awaits in-flight writes before flushing new args", async () => {
      let resolve1: () => void;
      const p1 = new Promise<void>((r) => {
        resolve1 = r;
      });
      fn.mockImplementationOnce(() => p1);

      debounced();
      const flush1 = debounced.flush();
      // flush is waiting for the in-flight write
      debounced(); // queue new args while flush is pending
      const flush2 = debounced.flush();

      // Complete the first write
      resolve1!();
      await Promise.all([flush1, flush2]);
      // Should have called fn twice: once for first args, once for second
      expect(fn.mock.calls).toHaveLength(2);
    });
  });

  describe("pause / resume", () => {
    it("pause() freezes the timer and delays invocation", async () => {
      debounced();
      debounced.pause();
      await tick(150);
      // Even after the original 100ms would have elapsed, fn is not called
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("resume() re-arms the timer with remaining delay", async () => {
      debounced();
      // Wait half the delay so ~50ms remain
      await tick(50);
      debounced.pause();
      await tick(200); // way past original deadline — should NOT fire
      expect(fn.mock.calls).toHaveLength(0);

      debounced.resume();
      await tick(80); // ~50ms remaining + slop
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("calling pause() while paused is a no-op", () => {
      debounced.pause();
      debounced.pause(); // no crash
    });

    it("calling resume() while not paused is a no-op", () => {
      debounced.resume(); // no crash
    });

    it("calling pause() before any call stores the full wait as remaining", async () => {
      debounced.pause(); // no pending call yet
      debounced(); // schedules with frozenRemainingMs = wait
      await tick(200);
      expect(fn.mock.calls).toHaveLength(0);

      debounced.resume();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("pause then resume without timer having started (idle) arms a fresh timer", async () => {
      debounced.pause();
      debounced.resume();
      // No call was ever made — nothing should happen
      await tick(150);
      expect(fn.mock.calls).toHaveLength(0);

      // Now make a call — should use normal wait
      debounced();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("pause during pending flush: soft flush does not write", async () => {
      debounced();
      debounced.pause();
      await debounced.flush(); // soft flush — no-op while paused
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("pause then force flush writes immediately", async () => {
      debounced();
      debounced.pause();
      await debounced.flush({ force: true });
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("resume after cancel does not re-arm a cancelled timer", async () => {
      debounced();
      debounced.pause();
      debounced.cancel();
      debounced.resume();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("new call after pause+resume starts a fresh timer", async () => {
      debounced();
      debounced.pause();
      await tick(60);
      debounced.resume();
      // The resumed timer may fire with remaining ~40ms
      await tick(100);
      expect(fn.mock.calls).toHaveLength(1);

      // New call should start a full wait timer (100ms)
      fn.mockClear();
      debounced();
      await tick(200);
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("resume without pending args is a no-op (no crash)", () => {
      debounced.pause();
      debounced.resume();
    });
  });

  describe("pause + cancel (discard scenario)", () => {
    it("cancel while paused prevents write on resume", async () => {
      debounced();
      debounced.pause();
      debounced.cancel();
      debounced.resume(); // should do nothing since args were cleared
      await tick(150);
      expect(fn.mock.calls).toHaveLength(0);
    });

    it("cancel then new call starts fresh", async () => {
      debounced();
      debounced.pause();
      debounced.cancel();
      debounced();
      debounced.resume();
      await tick(150);
      expect(fn.mock.calls).toHaveLength(1);
    });
  });

  describe("flush with force (save scenario)", () => {
    it("force flush writes even while paused", async () => {
      debounced();
      debounced.pause();
      await debounced.flush({ force: true });
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("force flush twice writes once (no duplicate)", async () => {
      debounced();
      await debounced.flush({ force: true });
      await debounced.flush({ force: true });
      expect(fn.mock.calls).toHaveLength(1);
    });

    it("force flush after new call while paused writes only once", async () => {
      debounced();
      debounced.pause();
      debounced(); // second call while paused — updates lastArgs
      await debounced.flush({ force: true });
      expect(fn.mock.calls).toHaveLength(1);
    });
  });
});
