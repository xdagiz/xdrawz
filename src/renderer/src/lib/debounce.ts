export function debounceAsync<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>,
  initialWait: number,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;
  let pending = Promise.resolve();
  let paused = false;
  let frozenRemainingMs: number | null = null;
  let deadlineMs: number | null = null;
  let wait = initialWait;

  const run = (args: TArgs) => {
    pending = pending
      .then(() => fn(...args))
      .catch((error) => console.error("debounced save failed", error));
    return pending;
  };

  const armTimer = (delay: number) => {
    if (timer) clearTimeout(timer);
    deadlineMs = Date.now() + delay;
    timer = setTimeout(
      () => {
        timer = null;
        deadlineMs = null;
        frozenRemainingMs = null;
        if (paused || !lastArgs) return;
        const argsToRun = lastArgs;
        lastArgs = null;
        void run(argsToRun);
      },
      Math.max(0, delay),
    );
  };

  const debounced = (...args: TArgs) => {
    lastArgs = args;
    if (paused) {
      if (frozenRemainingMs === null) frozenRemainingMs = wait;
      return;
    }
    armTimer(wait);
  };

  debounced.flush = async (opts?: { force?: boolean }) => {
    if (paused && !opts?.force) return pending;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    deadlineMs = null;
    frozenRemainingMs = null;

    if (lastArgs) {
      const argsToRun = lastArgs;
      lastArgs = null;
      await run(argsToRun);
    } else {
      await pending;
    }
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    deadlineMs = null;
    frozenRemainingMs = null;
  };

  debounced.pause = () => {
    if (paused) return;
    paused = true;

    if (timer && deadlineMs !== null) {
      frozenRemainingMs = Math.max(0, deadlineMs - Date.now());
      clearTimeout(timer);
      timer = null;
      deadlineMs = null;
    } else if (lastArgs && frozenRemainingMs === null) {
      frozenRemainingMs = wait;
    }
  };

  debounced.resume = () => {
    if (!paused) return;
    paused = false;

    if (!lastArgs) {
      frozenRemainingMs = null;
      return;
    }

    const remaining = frozenRemainingMs ?? wait;
    frozenRemainingMs = null;
    armTimer(remaining);
  };

  debounced.setWait = (nextMs: number) => {
    if (!Number.isFinite(nextMs) || nextMs <= 0) return;

    const remainingMs =
      deadlineMs !== null ? Math.max(0, deadlineMs - Date.now()) : frozenRemainingMs;

    wait = nextMs;

    if (lastArgs === null) {
      if (timer) clearTimeout(timer);
      timer = null;
      deadlineMs = null;
      frozenRemainingMs = null;
      return;
    }

    const delayMs = remainingMs === null ? wait : Math.min(remainingMs, wait);

    if (paused) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        deadlineMs = null;
      }
      frozenRemainingMs = delayMs;
      return;
    }

    armTimer(delayMs);
  };

  return debounced;
}
