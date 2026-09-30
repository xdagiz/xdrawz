export type SwitcherState = { phase: "idle" } | { phase: "cycling"; index: number };

export type SwitcherControllerDeps = {
  getCandidates: () => string[];
  canSwitchNow: () => boolean;
  commit: (fileId: string) => void;
  onChange: (state: SwitcherState) => void;
  scheduleTimeout?: (fn: () => void, ms: number) => () => void;
  fallbackMs?: number;
};

const DEFAULT_FALLBACK_MS = 600;

const wrapIndex = (index: number, length: number) => ((index % length) + length) % length;

export type SwitcherController = ReturnType<typeof createSwitcherController>;

export const createSwitcherController = (deps: SwitcherControllerDeps) => {
  const schedule =
    deps.scheduleTimeout ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const fallbackMs = deps.fallbackMs ?? DEFAULT_FALLBACK_MS;

  let state: SwitcherState = { phase: "idle" };
  let cancelFallback: (() => void) | null = null;
  let autoCommitBlocked = false;

  const emit = () => deps.onChange(state);
  const clearFallback = () => {
    cancelFallback?.();
    cancelFallback = null;
  };

  const fallbackTick = () => {
    if (autoCommitBlocked) {
      cancelFallback = schedule(fallbackTick, fallbackMs);
      return;
    }

    cancelFallback = null;
    controller.commit();
  };

  const armFallback = () => {
    clearFallback();
    cancelFallback = schedule(fallbackTick, fallbackMs);
  };

  const controller = {
    getState: (): SwitcherState => state,

    setAutoCommitBlocked: (blocked: boolean) => {
      autoCommitBlocked = blocked;
    },

    start: (direction: 1 | -1 = 1) => {
      if (state.phase === "cycling") {
        controller.step(direction);
        return;
      }
      if (!deps.canSwitchNow()) return;

      const candidates = deps.getCandidates();
      if (candidates.length <= 1) return;

      state = { phase: "cycling", index: wrapIndex(direction, candidates.length) };
      armFallback();
      emit();
    },

    step: (delta: number) => {
      if (state.phase !== "cycling") return;

      const candidates = deps.getCandidates();
      if (candidates.length <= 1) {
        controller.cancel();
        return;
      }

      state = { phase: "cycling", index: wrapIndex(state.index + delta, candidates.length) };
      armFallback();
      emit();
    },

    commitAt: (index: number) => {
      if (state.phase !== "cycling") return;

      const candidates = deps.getCandidates();
      const clamped = Math.min(Math.max(index, 0), candidates.length - 1);
      if (clamped < 0) {
        controller.cancel();
        return;
      }

      state = { phase: "cycling", index: clamped };
      controller.commit();
    },

    commit: () => {
      if (state.phase !== "cycling") return;

      const candidates = deps.getCandidates();
      if (state.index >= candidates.length) {
        controller.cancel();
        return;
      }

      const target = candidates[state.index];
      clearFallback();
      state = { phase: "idle" };
      emit();

      if (target !== undefined) deps.commit(target);
    },

    cancel: () => {
      if (state.phase === "idle") return;
      clearFallback();
      state = { phase: "idle" };
      emit();
    },
  };

  return controller;
};
