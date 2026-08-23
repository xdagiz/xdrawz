let active = false;
const startListeners = new Set<() => void>();

export const setCloseHandshakeActive = (value: boolean): void => {
  if (active === value) return;
  active = value;
  if (!value) return;
  for (const listener of startListeners) listener();
};

export const isCloseHandshakeActive = (): boolean => active;

export const onCloseHandshakeStart = (listener: () => void): (() => void) => {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
};
