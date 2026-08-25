import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type BoundDrawingSession, sessionOwner } from "@/lib/session-owner";

import { useDrawingSession } from "./use-drawing-session";

const h = vi.hoisted(() => {
  const createdDeps: Array<{ fileId: string; save: unknown; onDirtyChange: unknown }> = [];
  const raws: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const queue: Array<{ run: () => void | (() => void); deps?: unknown[] }> = [];
  const cleanups: Array<void | (() => void)> = [];
  const prevDeps: Array<unknown[] | undefined> = [];

  return {
    createdDeps,
    raws,
    queue,
    cleanups,
    prevDeps,
    liveRef: null as null | { current: unknown },
    makeRaw: () => {
      const raw = {
        onChange: vi.fn(),
        saveNow: vi.fn(async () => true),
        flush: vi.fn(async () => {}),
        setAutosavePaused: vi.fn(),
        getSerializedContent: vi.fn(() => "{}"),
        setInitialBaseline: vi.fn(),
        resetBaseline: vi.fn(),
        ensureCleanOrConfirm: vi.fn(async () => true),
        isDirty: vi.fn(() => false),
        dispose: vi.fn(),
      };
      raws.push(raw);
      return raw;
    },
  };
});

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    if (!h.liveRef) h.liveRef = { current: initial };
    return h.liveRef;
  },
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => {
    h.queue.push({ run, deps });
  },
}));

vi.mock("@/lib/drawing-session", () => ({
  createDrawingSession: (deps: { fileId: string; save: unknown; onDirtyChange: unknown }) => {
    h.createdDeps.push(deps);
    return h.makeRaw();
  },
}));

type FakeRaw = Record<string, ReturnType<typeof vi.fn>>;

type HookArgs = [
  fileId: string,
  save: (id: string, content: string, origin?: string) => Promise<boolean>,
  onDirtyChange: (id: string, dirty: boolean) => void,
  ref: RefObject<BoundDrawingSession | null>,
];

const save = vi.fn(async () => true);
const onDirtyChange = vi.fn();

const newRef = (): RefObject<BoundDrawingSession | null> => ({ current: null });

const depsEqual = (a?: unknown[], b?: unknown[]) =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((v, i) => Object.is(v, b[i]));

const useMount = (...args: HookArgs) => {
  const [fileId, , , ref] = args;
  h.queue.length = 0;
  useDrawingSession(...args);
  h.queue.forEach(({ run }, i) => {
    h.cleanups[i] = run();
  });
  h.prevDeps = h.queue.map(({ deps }) => deps);
  void fileId;
  return ref;
};

const useUpdate = (...args: HookArgs) => {
  const [, , , ref] = args;
  h.queue.length = 0;
  useDrawingSession(...args);
  h.queue.forEach(({ run, deps }, i) => {
    if (depsEqual(deps, h.prevDeps[i])) return;
    h.cleanups[i]?.();
    h.cleanups[i] = run();
  });
  h.prevDeps = h.queue.map(({ deps }) => deps);
  return ref;
};

const unmount = () => {
  h.cleanups.toReversed().forEach((cleanup) => cleanup?.());
  h.cleanups.length = 0;
  h.prevDeps.length = 0;
};

const listenerFor = (
  target: { addEventListener: ReturnType<typeof vi.fn> },
  event: string,
): ((...args: unknown[]) => void) => {
  const entry = target.addEventListener.mock.calls.find(([name]) => name === event);
  if (!entry) throw new Error(`no ${event} listener registered`);
  return entry[1] as (...args: unknown[]) => void;
};

const currentFake = (): FakeRaw => {
  const bound = sessionOwner.getSession();
  if (!bound) throw new Error("no active session");
  for (const raw of h.raws.toReversed()) {
    if (raw.dispose === (bound as unknown as FakeRaw).dispose) return raw;
  }
  throw new Error("active session is not a known fake");
};

const windowTarget = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
const documentTarget = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

describe("useDrawingSession", () => {
  beforeEach(() => {
    h.createdDeps.length = 0;
    h.raws.length = 0;
    h.queue.length = 0;
    h.cleanups.length = 0;
    h.prevDeps.length = 0;
    h.liveRef = null;
    sessionOwner.setActiveForTest(null);
    windowTarget.addEventListener.mockClear();
    windowTarget.removeEventListener.mockClear();
    documentTarget.addEventListener.mockClear();
    documentTarget.removeEventListener.mockClear();
    save.mockClear();
    onDirtyChange.mockClear();
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
  });

  it("acquires a live session and forwards its creation deps", () => {
    const ref = useMount("f1", save, onDirtyChange, newRef());

    expect(ref.current).toBe(sessionOwner.getSession());
    expect(h.createdDeps).toEqual([
      { fileId: "f1", save, onDirtyChange, onSaveGaveUp: expect.any(Function) },
    ]);
  });

  it("registers each edge listener once and keeps them across rerenders", () => {
    useMount("f1", save, onDirtyChange, newRef());
    useUpdate("f1", save, onDirtyChange, newRef());

    expect(windowTarget.addEventListener).toHaveBeenCalledTimes(2);
    expect(documentTarget.addEventListener).toHaveBeenCalledTimes(1);
    expect(windowTarget.addEventListener).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(windowTarget.addEventListener).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );
    expect(documentTarget.addEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("flushes the live session without force on edge events", () => {
    useMount("f1", save, onDirtyChange, newRef());
    const fake = currentFake();
    listenerFor(windowTarget, "blur")();
    listenerFor(documentTarget, "visibilitychange")();

    expect(fake.flush).toHaveBeenCalledTimes(2);
    expect(fake.flush).toHaveBeenCalledWith();
  });

  it("releases the old session when the fileId changes without unmounting", () => {
    useMount("f1", save, onDirtyChange, newRef());
    const first = currentFake();

    const ref = useUpdate("f2", save, onDirtyChange, newRef());

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(sessionOwner.getSession("f1")).toBeNull();
    expect(ref.current).toBe(sessionOwner.getSession());
    expect(windowTarget.addEventListener).toHaveBeenCalledTimes(2);
  });

  it("unmount removes listeners, releases the session, and clears the ref", () => {
    const ref = useMount("f1", save, onDirtyChange, newRef());
    const fake = currentFake();
    const blur = listenerFor(windowTarget, "blur");

    unmount();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(sessionOwner.getSession()).toBeNull();
    expect(ref.current).toBeNull();
    expect(windowTarget.removeEventListener).toHaveBeenCalledWith("blur", blur);
    expect(documentTarget.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(windowTarget.removeEventListener).toHaveBeenCalledWith(
      "beforeunload",
      expect.any(Function),
    );

    blur();
    expect(fake.flush).not.toHaveBeenCalled();
  });

  it("supports an unmount then remount cycle like StrictMode", () => {
    useMount("f1", save, onDirtyChange, newRef());
    const first = currentFake();
    unmount();

    const ref = useMount("f1", save, onDirtyChange, newRef());

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(sessionOwner.getSession());
  });

  it("clears its fileId's dirty flag on unmount", () => {
    useMount("f1", save, onDirtyChange, newRef());
    onDirtyChange.mockClear();

    unmount();

    expect(onDirtyChange).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenCalledWith("f1", false);
  });
});
