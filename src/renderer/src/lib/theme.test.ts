import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  getSystemPrefersDark,
  parseThemePreference,
  readStoredTheme,
  resolveTheme,
  subscribeSystemPrefersDark,
  writeStoredTheme,
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

describe("parseThemePreference", () => {
  it("accepts light, dark, and system", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("rejects garbage and null", () => {
    expect(parseThemePreference("midnight")).toBeNull();
    expect(parseThemePreference("")).toBeNull();
    expect(parseThemePreference(null)).toBeNull();
  });
});

describe("readStoredTheme", () => {
  it("reads a valid stored preference from storage", () => {
    const storage = {
      getItem: (key: string) => (key === THEME_STORAGE_KEY ? "dark" : null),
    };

    expect(readStoredTheme(storage)).toBe("dark");
  });

  it("falls back to system on garbage values", () => {
    const storage = {
      getItem: () => "neon",
    };

    expect(readStoredTheme(storage)).toBe("system");
  });

  it("falls back to system on missing value", () => {
    const storage = {
      getItem: () => null,
    };

    expect(readStoredTheme(storage)).toBe("system");
  });

  it("falls back to system when storage throws (private mode / opaque origin)", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };

    expect(readStoredTheme(storage)).toBe("system");
  });
});

describe("writeStoredTheme", () => {
  it("writes the preference under the theme key", () => {
    const setItem = vi.fn();
    writeStoredTheme({ setItem }, "light");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
  });

  it("swallows storage errors", () => {
    const setItem = () => {
      throw new Error("QuotaExceededError");
    };

    expect(() => writeStoredTheme({ setItem }, "dark")).not.toThrow();
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
