import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isCloseHandshakeActive,
  onCloseHandshakeStart,
  setCloseHandshakeActive,
} from "./close-handshake";

describe("close-handshake flag", () => {
  afterEach(() => {
    setCloseHandshakeActive(false);
  });

  it("starts inactive", () => {
    expect(isCloseHandshakeActive()).toBe(false);
  });

  it("toggles on and back off", () => {
    setCloseHandshakeActive(true);
    expect(isCloseHandshakeActive()).toBe(true);

    setCloseHandshakeActive(false);
    expect(isCloseHandshakeActive()).toBe(false);
  });

  it("notifies subscribers when the handshake starts", () => {
    const listener = vi.fn();
    const unsubscribe = onCloseHandshakeStart(listener);

    setCloseHandshakeActive(true);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not notify when already active or when deactivating", () => {
    const listener = vi.fn();
    const unsubscribe = onCloseHandshakeStart(listener);

    setCloseHandshakeActive(false);
    setCloseHandshakeActive(true);
    listener.mockClear();
    setCloseHandshakeActive(true);
    setCloseHandshakeActive(false);
    setCloseHandshakeActive(false);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onCloseHandshakeStart(listener);
    unsubscribe();

    setCloseHandshakeActive(true);

    expect(listener).not.toHaveBeenCalled();
    setCloseHandshakeActive(false);
  });
});
