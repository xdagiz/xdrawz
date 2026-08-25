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

  const state: {
    refSlots: Array<{ current: unknown } | undefined>;
    nextSlot: number;
    [key: string]: unknown;
  } = { refSlots: [], nextSlot: 0 };

  state.beginRender = () => {
    state.nextSlot = 0;
  };
  state.resetRefs = () => {
    state.refSlots = [];
    state.nextSlot = 0;
  };

  return {
    createdDeps,
    raws,
    queue,
    cleanups,
    prevDeps,
    beginRender: state.beginRender as () => void,
    resetRefs: state.resetRefs as () => void,
    useRefMock: (initial: unknown) => {
      let slot = state.refSlots[state.nextSlot];
      if (!slot) {
        slot = { current: initial };
        state.refSlots[state.nextSlot] = slot;
      }
      state.nextSlot += 1;
      return slot;
    },
    makeRaw: () => {
      const raw = {
        onChange: vi.fn(),
        saveNow: vi.fn(async () => true),
        flush: vi.fn(async () => {}),
        setAutosavePaused: vi.fn(),
        getSerializedContent: vi.fn(() => "{}"),
        setInitialBaseline: vi.fn(),
        resetBaseline: vi.fn(),
        retarget: vi.fn(),
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
  useRef: (initial: unknown) => h.useRefMock(initial),
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
  h.queue.length = 0;
  h.beginRender();
  useDrawingSession(...args);
  h.queue.forEach(({ run }, i) => {
    h.cleanups[i] = run();
  });
  h.prevDeps = h.queue.map(({ deps }) => deps);
  return args[3];
};

const useUpdate = (...args: HookArgs) => {
  h.queue.length = 0;
  h.beginRender();
  useDrawingSession(...args);
  h.queue.forEach(({ run, deps }, i) => {
    if (depsEqual(deps, h.prevDeps[i])) return;
    h.cleanups[i]?.();
    h.cleanups[i] = run();
  });
  h.prevDeps = h.queue.map(({ deps }) => deps);
  return args[3];
};

const unmount = () => {
  h.cleanups.toReversed().forEach((cleanup) => cleanup?.());
  h.cleanups.length = 0;
  h.prevDeps.length = 0;
  h.resetRefs();
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
    h.resetRefs();
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
    const ref = newRef();
    useMount("f1", save, onDirtyChange, ref);
    useUpdate("f1", save, onDirtyChange, ref);

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
    const ref = newRef();
    useMount("f1", save, onDirtyChange, ref);
    const fake = currentFake();
    listenerFor(windowTarget, "blur")();
    listenerFor(documentTarget, "visibilitychange")();

    expect(fake.flush).toHaveBeenCalledTimes(2);
    expect(fake.flush).toHaveBeenCalledWith();
  });

  it("retargets the live session when the fileId changes without unmounting", () => {
    const retargetSpy = vi.spyOn(sessionOwner, "retargetActive");
    const ref = newRef();
    useMount("f1", save, onDirtyChange, ref);
    const first = currentFake();

    useUpdate("f2", save, onDirtyChange, ref);

    expect(first.dispose).not.toHaveBeenCalled();
    expect(retargetSpy).toHaveBeenCalledWith("f1", "f2");
    expect(sessionOwner.getActiveFileId()).toBe("f2");
    expect(sessionOwner.getSession("f2")).toBe(sessionOwner.getSession());
    expect(ref.current).toBe(sessionOwner.getSession());
    expect(h.createdDeps.length).toBe(1);
    retargetSpy.mockRestore();
  });

  it("unmount removes listeners, releases the session, and clears the ref", () => {
    const ref = useMount("f1", save, onDirtyChange, newRef());
    const fake = currentFake();
    const blur = listenerFor(windowTarget, "blur");

    unmount();

    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(sessionOwner.getSession()).toBeNull();
    expect(sessionOwner.getActiveFileId()).toBeNull();
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
    const ref = newRef();
    useMount("f1", save, onDirtyChange, ref);
    const first = currentFake();
    unmount();

    useMount("f1", save, onDirtyChange, ref);

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(sessionOwner.getSession());
  });

  it("clears the owned file id's dirty flag on unmount, including after a retarget", () => {
    const ref = newRef();
    useMount("f1", save, onDirtyChange, ref);
    useUpdate("f2", save, onDirtyChange, ref);
    onDirtyChange.mockClear();

    unmount();

    expect(onDirtyChange).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenCalledWith("f2", false);
  });
});
