(function () {
  "use strict";

  const STORAGE_KEY = "xdrawz:theme";
  const prefersDarkQuery = "(prefers-color-scheme: dark)";

  const readPreference = () => {
    let value = null;
    try {
      value = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      value = null;
    }
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  };

  const preference = readPreference();
  const systemDark =
    typeof window.matchMedia === "function" && window.matchMedia(prefersDarkQuery).matches;
  const resolved =
    preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";

  const root = document.documentElement;
  if (root) {
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
  }
})();
