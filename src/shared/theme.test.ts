import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyDocumentTheme,
  applyPreferenceToDocument,
  getSystemPrefersDark,
  resolveTheme,
  subscribeSystemPrefersDark,
} from "./theme";

describe("resolveTheme", () => {
  it("returns light/dark preferences as-is", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system flag when preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("system preference helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getSystemPrefersDark reads matchMedia", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("window", { matchMedia });

    expect(getSystemPrefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
  });

  it("getSystemPrefersDark is false when matchMedia is missing", () => {
    vi.stubGlobal("window", {});
    expect(getSystemPrefersDark()).toBe(false);
  });

  it("subscribeSystemPrefersDark wires and tears down the listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: false,
        addEventListener,
        removeEventListener,
      }),
    });

    const listener = vi.fn();
    const unsubscribe = subscribeSystemPrefersDark(listener);

    expect(addEventListener).toHaveBeenCalledWith("change", listener);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});

describe("applyDocumentTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles the dark class and color-scheme", () => {
    const classList = { toggle: vi.fn() };
    const style = { colorScheme: "" };
    vi.stubGlobal("document", {
      documentElement: { classList, style },
    });

    applyDocumentTheme("dark");
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(style.colorScheme).toBe("dark");

    applyDocumentTheme("light");
    expect(classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(style.colorScheme).toBe("light");
  });

  it("no-ops when document is unavailable", () => {
    vi.stubGlobal("document", undefined);
    expect(() => applyDocumentTheme("dark")).not.toThrow();
  });

  it("no-ops when documentElement is null (early preload)", () => {
    vi.stubGlobal("document", { documentElement: null });
    expect(() => applyDocumentTheme("dark")).not.toThrow();
  });
});

describe("applyPreferenceToDocument", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves system preference and paints the document", () => {
    const classList = { toggle: vi.fn() };
    const style = { colorScheme: "" };
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal("document", {
      documentElement: { classList, style },
    });

    expect(applyPreferenceToDocument("system")).toBe("dark");
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(style.colorScheme).toBe("dark");
  });
});

describe("schedulePreferenceToDocument", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints immediately when documentElement exists", async () => {
    const { schedulePreferenceToDocument } = await import("./theme");
    const classList = { toggle: vi.fn() };
    const style = { colorScheme: "" };
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: { classList, style },
      addEventListener: vi.fn(),
    });

    schedulePreferenceToDocument("dark");
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(document.addEventListener).not.toHaveBeenCalled();
  });

  it("defers to DOMContentLoaded when documentElement is null", async () => {
    const { schedulePreferenceToDocument } = await import("./theme");
    const addEventListener = vi.fn();
    const classList = { toggle: vi.fn() };
    const style = { colorScheme: "" };
    const doc: {
      documentElement: {
        classList: { toggle: ReturnType<typeof vi.fn> };
        style: { colorScheme: string };
      } | null;
      addEventListener: ReturnType<typeof vi.fn>;
    } = {
      documentElement: null,
      addEventListener,
    };

    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal("document", doc);

    schedulePreferenceToDocument("system");
    expect(addEventListener).toHaveBeenCalledWith("DOMContentLoaded", expect.any(Function), {
      once: true,
    });
    expect(classList.toggle).not.toHaveBeenCalled();

    doc.documentElement = { classList, style };
    const paint = addEventListener.mock.calls[0][1] as () => void;
    paint();
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
  });
});
