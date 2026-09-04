const startListeners = new Set<() => void>();
let active = false;

export const setCloseHandshakeActive = (value: boolean) => {
  if (active === value) return;
  active = value;
  if (!value) return;
  for (const listener of startListeners) listener();
};

export const isCloseHandshakeActive = () => active;

export const onCloseHandshakeStart = (listener: () => void) => {
  startListeners.add(listener);
  if (active) listener();

  return () => {
    startListeners.delete(listener);
  };
};

type BeforeUnloadGuardEvent = {
  preventDefault: () => void;
  returnValue: unknown;
};

export const createBeforeUnloadGuard = (getDirtyCount: () => number) => {
  return (event: BeforeUnloadGuardEvent) => {
    if (getDirtyCount() <= 0) return;
    event.preventDefault();
    event.returnValue = "";
  };
};
