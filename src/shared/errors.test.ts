import { describe, expect, it } from "vite-plus/test";

import { toRendererSafe, toSerialized } from "./errors";

describe("toRendererSafe", () => {
  it("keeps the envelope fields and drops stack and cause", () => {
    const inner = new Error("inner failure");
    const outer = new Error("outer failure") as Error & { cause: unknown };
    outer.cause = inner;

    const full = toSerialized(outer, "save");
    expect(full.stack).toBeDefined();
    expect(full.cause).toBeDefined();

    const trimmed = toRendererSafe(full);
    expect(trimmed.$isAppError).toBe(true);
    expect(trimmed.name).toBe(full.name);
    expect(trimmed.message).toBe(full.message);
    expect(trimmed.code).toBe(full.code);
    expect(trimmed.operation).toBe(full.operation);
    expect(trimmed.retryable).toBe(full.retryable);
    expect(trimmed.stack).toBeUndefined();
    expect(trimmed.cause).toBeUndefined();
  });
});
