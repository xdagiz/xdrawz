import { DEFAULT_THEME, type ThemePreference } from "@shared/ipc";

export type ResolvedTheme = "light" | "dark";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
export const THEME_STORAGE_KEY = "xcalidraw:theme";

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ResolvedTheme => {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
};

export const getSystemPrefersDark = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
};

export const parseThemePreference = (value: string | null) => {
  return value === "light" || value === "dark" || value === "system" ? value : null;
};

export const readStoredTheme = (storage: Pick<Storage, "getItem">): ThemePreference => {
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY)) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

export const writeStoredTheme = (storage: Pick<Storage, "setItem">, theme: ThemePreference) => {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* boot cache must never break settings - silent */
  }
};

export const subscribeSystemPrefersDark = (onStoreChange: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const mq = window.matchMedia(SYSTEM_DARK_QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
};

const hasDocumentElement = () => {
  return typeof document !== "undefined" && document.documentElement != null;
};

export const applyDocumentTheme = (resolved: ResolvedTheme) => {
  if (!hasDocumentElement()) return;

  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
};
