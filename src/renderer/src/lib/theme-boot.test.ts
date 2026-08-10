/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY } from "@/lib/theme";

const BOOT_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/theme-boot.js",
);

const bootScript = readFileSync(BOOT_SCRIPT_PATH, "utf8");
const run = () => Function(bootScript)();

type BootDom = {
  classList: { toggle: ReturnType<typeof vi.fn> };
  style: { colorScheme: string };
};

const stubDom = (
  options: { stored?: string | null; systemDark?: boolean; getItemThrows?: boolean } = {},
): BootDom => {
  const classList = { toggle: vi.fn() };
  const style = { colorScheme: "" };
  const getItem = options.getItemThrows
    ? () => {
        throw new Error("SecurityError");
      }
    : (key: string) => (key === THEME_STORAGE_KEY ? (options.stored ?? null) : null);
  vi.stubGlobal("window", {
    localStorage: { getItem },
    matchMedia: () => ({ matches: options.systemDark ?? false }),
  });
  vi.stubGlobal("document", { documentElement: { classList, style } });
  return { classList, style };
};

describe("theme-boot.js", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints light with no stored preference on a light system", () => {
    const { classList, style } = stubDom({ stored: null, systemDark: false });

    run();

    expect(classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(style.colorScheme).toBe("light");
  });

  it("paints dark for the stored dark preference", () => {
    const { classList, style } = stubDom({ stored: "dark" });

    run();

    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(style.colorScheme).toBe("dark");
  });

  it("paints light for the stored light preference even on a dark system", () => {
    const { classList, style } = stubDom({ stored: "light", systemDark: true });

    run();

    expect(classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(style.colorScheme).toBe("light");
  });

  it("follows the system scheme for the stored system preference", () => {
    const dark = stubDom({ stored: "system", systemDark: true });
    run();
    expect(dark.classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(dark.style.colorScheme).toBe("dark");

    vi.unstubAllGlobals();
    const light = stubDom({ stored: "system", systemDark: false });
    run();
    expect(light.classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(light.style.colorScheme).toBe("light");
  });

  it("falls back to the system scheme on garbage stored values", () => {
    const { classList, style } = stubDom({ stored: "neon", systemDark: true });

    run();

    expect(classList.toggle).toHaveBeenCalledWith("dark", true);
    expect(style.colorScheme).toBe("dark");
  });

  it("falls back to the system scheme when storage access throws", () => {
    const { classList, style } = stubDom({ getItemThrows: true, systemDark: false });

    expect(() => run()).not.toThrow();

    expect(classList.toggle).toHaveBeenCalledWith("dark", false);
    expect(style.colorScheme).toBe("light");
  });
});
