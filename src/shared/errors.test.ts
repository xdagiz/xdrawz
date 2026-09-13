import { describe, expect, it } from "vite-plus/test";

import { isNotFoundError, toRendererSafe, toSerialized } from "./errors";

describe("toRendererSafe", () => {
  it("keeps the envelope fields and drops stack and cause", () => {
    const inner = new Error("inner failure");
    const outer = new Error("outer failure") as Error & { cause: unknown };
    outer.cause = inner;
    const full = toSerialized(outer, "save");
    expect(full.stack).toBeDefined();
    expect(full.cause).toBeDefined();
    expect(full.code).toBe("UNKNOWN");
    expect(full.operation).toBe("save");
    expect(full.details).toEqual({ code: "UNKNOWN", reason: "io" });
    const trimmed = toRendererSafe(full);
    expect(trimmed.$isAppError).toBe(true);
    expect(trimmed.name).toBe(full.name);
    expect(trimmed.message).toBe(full.message);
    expect(trimmed.code).toBe(full.code);
    expect(trimmed.operation).toBe(full.operation);
    expect(trimmed.retryable).toBe(full.retryable);
    expect(trimmed.details).toEqual(full.details);
    expect("stack" in trimmed).toBe(false);
    expect("cause" in trimmed).toBe(false);
  });

  it("overrides operation and derives retryable from details", () => {
    const coded = Object.assign(new Error("gone"), {
      code: "NOT_FOUND",
      details: { code: "NOT_FOUND", reason: "missing-file" },
    });
    const first = toSerialized(coded, "read");
    expect(first.operation).toBe("read");
    expect(first.retryable).toBe(false);
    const second = toSerialized(first, "save");
    expect(second.operation).toBe("save");
    expect(second.code).toBe("NOT_FOUND");
  });

  it("detects not found errors by details only", () => {
    expect(
      isNotFoundError({
        $isAppError: true,
        name: "Error",
        message: "gone",
        code: "NOT_FOUND",
        operation: "read",
        retryable: false,
        details: { code: "NOT_FOUND", reason: "missing-file" },
      }),
    ).toBe(true);
    expect(isNotFoundError({ details: { code: "NOT_FOUND", reason: "missing-parent" } })).toBe(
      true,
    );
    expect(isNotFoundError({ details: { code: "UNKNOWN", reason: "io" } })).toBe(false);
    expect(isNotFoundError(new Error("other"))).toBe(false);
  });
});
