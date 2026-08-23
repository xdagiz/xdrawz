import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats sub-minute ages as just now", () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe("2d ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(formatRelativeTime(Date.now() + 60_000)).toBe("just now");
  });
});
