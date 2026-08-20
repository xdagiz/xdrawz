import type { ErrorOperation, Result } from "@shared/errors";
import { toSerialized } from "@shared/errors";

export const withIpcResult = async <T>(
  operation: ErrorOperation,
  fn: () => Promise<T> | T,
): Promise<Result<T>> => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toSerialized(error, operation) };
  }
};

let lastFatalAt = 0;

export const shouldQuitAfterFatal = (now = Date.now()) => {
  const previous = lastFatalAt;
  lastFatalAt = now;
  return previous === 0 || now - previous >= 60_000;
};

export const resetFatalState = () => {
  lastFatalAt = 0;
};
