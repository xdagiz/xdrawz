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

  it("collapses rapid calls into one invocation with the latest args", async () => {
    const withArgs = debounceAsync<[a: string, b: number]>(fn, 50);
    withArgs("first", 1);
    withArgs("second", 2);
    await tick(80);

    expect(fn.mock.calls).toHaveLength(1);
    expect(fn.mock.calls[0]).toEqual(["second", 2]);
    withArgs.cancel();

    debounced();
    debounced();
    debounced();
    await tick(150);
    expect(fn.mock.calls).toHaveLength(2);
  });

  it("cancel prevents pending invocation and leaves nothing for flush", async () => {
    debounced();
    debounced.cancel();
    await tick(150);
    await debounced.flush();

    expect(fn.mock.calls).toHaveLength(0);

    debounced();
    await tick(150);
    expect(fn.mock.calls).toHaveLength(1);
  });

  it("flush invokes the pending call immediately; multiple flushes run once", async () => {
    debounced();
    await debounced.flush();
    await debounced.flush();

    expect(fn.mock.calls).toHaveLength(1);
  });

  it("awaits an in-flight write before flushing newer args", async () => {
    let resolve1: () => void;
    const p1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    fn.mockImplementationOnce(() => p1);

    debounced();
    const flush1 = debounced.flush();
    debounced();
    const flush2 = debounced.flush();

    resolve1!();
    await Promise.all([flush1, flush2]);

    expect(fn.mock.calls).toHaveLength(2);
  });

  it("pause freezes the timer and resume re-arms with the remaining delay", async () => {
    debounced();
    await tick(50);
    debounced.pause();
    await tick(200);
    expect(fn.mock.calls).toHaveLength(0);

    debounced.resume();
    await tick(80);
    expect(fn.mock.calls).toHaveLength(1);
  });

  it("soft flush while paused does not write; force flush does", async () => {
    debounced();
    debounced.pause();

    await debounced.flush();
    expect(fn.mock.calls).toHaveLength(0);

    await debounced.flush({ force: true });
    expect(fn.mock.calls).toHaveLength(1);
  });

  it("cancel while paused discards the pending args before resume", async () => {
    debounced();
    debounced.pause();
    debounced.cancel();
    debounced.resume();
    await tick(150);

    expect(fn.mock.calls).toHaveLength(0);
  });

  it("force flush twice writes once", async () => {
    debounced();
    await debounced.flush({ force: true });
    await debounced.flush({ force: true });

    expect(fn.mock.calls).toHaveLength(1);
  });

  it("a new call after pause and resume starts a fresh full wait", async () => {
    debounced();
    debounced.pause();
    await tick(60);
    debounced.resume();
    await tick(100);
    expect(fn.mock.calls).toHaveLength(1);

    fn.mockClear();
    debounced();
    await tick(50);
    expect(fn.mock.calls).toHaveLength(0);
    await tick(100);
    expect(fn.mock.calls).toHaveLength(1);
  });
});
