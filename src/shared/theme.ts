import type { ThemePreference } from "./ipc";

export type ResolvedTheme = "light" | "dark";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export const resolveTheme = (preference: ThemePreference, systemDark: boolean): ResolvedTheme => {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
};

export const getSystemPrefersDark = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
};

export const subscribeSystemPrefersDark = (onStoreChange: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const mq = window.matchMedia(SYSTEM_DARK_QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
};

const hasDocumentElement = (): boolean =>
  typeof document !== "undefined" && document.documentElement != null;

export const applyDocumentTheme = (resolved: ResolvedTheme): void => {
  if (!hasDocumentElement()) return;

  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
};

export const applyPreferenceToDocument = (preference: ThemePreference) => {
  const resolved = resolveTheme(preference, getSystemPrefersDark());
  applyDocumentTheme(resolved);
  return resolved;
};

export const schedulePreferenceToDocument = (preference: ThemePreference): void => {
  const paint = () => applyPreferenceToDocument(preference);

  if (hasDocumentElement()) {
    paint();
    return;
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", paint, { once: true });
    return;
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("DOMContentLoaded", paint, { once: true });
  }
};
