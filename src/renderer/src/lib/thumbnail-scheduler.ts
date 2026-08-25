export type IdleDeadline = { timeRemaining: () => number };

export type SlotRequester = (callback: (deadline: IdleDeadline) => void) => () => void;

export type SlotPump = {
  kick: () => void;
  cancel: () => void;
};

export type SlotPumpDeps = {
  drain: (deadline: IdleDeadline | undefined) => void;
  requestSlot?: SlotRequester;
};

export const DEFAULT_SLOT_REQUESTER: SlotRequester = (callback) => {
  const idle = globalThis as typeof globalThis & {
    requestIdleCallback?: (
      cb: (deadline: IdleDeadline) => void,
      opts?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  if (typeof idle.requestIdleCallback === "function") {
    const id = idle.requestIdleCallback(callback, { timeout: 2000 });
    return () => idle.cancelIdleCallback?.(id);
  }

  const id = setTimeout(() => callback({ timeRemaining: () => 0 }), 16);
  return () => clearTimeout(id);
};

export const createSlotPump = (deps: SlotPumpDeps): SlotPump => {
  const requestSlot = deps.requestSlot ?? DEFAULT_SLOT_REQUESTER;
  let cancelCurrent: (() => void) | null = null;

  const fire = (deadline: IdleDeadline | undefined) => {
    cancelCurrent = null;
    deps.drain(deadline);
  };

  return {
    kick: () => {
      if (cancelCurrent) return;
      cancelCurrent = requestSlot((deadline) => fire(deadline));
    },
    cancel: () => {
      cancelCurrent?.();
      cancelCurrent = null;
    },
  };
};
