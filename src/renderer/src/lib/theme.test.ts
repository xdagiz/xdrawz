import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  getSystemPrefersDark,
  readStoredTheme,
  resolveTheme,
  subscribeSystemPrefersDark,
  writeStoredTheme,
} from "./theme";

describe("theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves explicit preferences directly and system via the flag", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("reads stored preferences and falls back to system on garbage, missing, or throwing storage", () => {
    expect(readStoredTheme({ getItem: () => "dark" })).toBe("dark");
    expect(readStoredTheme({ getItem: () => "neon" })).toBe("system");
    expect(readStoredTheme({ getItem: () => null })).toBe("system");
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBe("system");
  });

  it("writes the preference under the theme key and swallows storage errors", () => {
    const setItem = vi.fn();
    writeStoredTheme({ setItem }, "light");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");

    expect(() =>
      writeStoredTheme(
        {
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        },
        "dark",
      ),
    ).not.toThrow();
  });

  it("getSystemPrefersDark reads matchMedia and is false without it", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("window", { matchMedia });

    expect(getSystemPrefersDark()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");

    vi.stubGlobal("window", {});
    expect(getSystemPrefersDark()).toBe(false);
  });

  it("subscribeSystemPrefersDark wires and tears down the listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener, removeEventListener }),
    });

    const listener = vi.fn();
    const unsubscribe = subscribeSystemPrefersDark(listener);

    expect(addEventListener).toHaveBeenCalledWith("change", listener);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });

  it("applyDocumentTheme toggles the dark class and color-scheme", () => {
    const classList = { toggle: vi.fn() };
    const style = { colorScheme: "" };
    vi.stubGlobal("document", { documentElement: { classList, style } });

    applyDocumentTheme("dark");
    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(style.colorScheme).toBe("dark");

    applyDocumentTheme("light");
    expect(classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(style.colorScheme).toBe("light");
  });
});
