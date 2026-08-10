import type { ThemePreference } from "@shared/ipc";
import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

import {
  applyDocumentTheme,
  getSystemPrefersDark,
  resolveTheme,
  subscribeSystemPrefersDark,
} from "@/lib/theme";

import { ThemeContext } from "./theme-context";

const useSystemPrefersDark = () => {
  return useSyncExternalStore(subscribeSystemPrefersDark, getSystemPrefersDark, () => false);
};

type ThemeProviderProps = {
  preference: ThemePreference;
  children: ReactNode;
};

export const ThemeProvider = ({ preference, children }: ThemeProviderProps) => {
  const systemDark = useSystemPrefersDark();
  const resolved = useMemo(() => resolveTheme(preference, systemDark), [preference, systemDark]);

  useLayoutEffect(() => {
    applyDocumentTheme(resolved);
  }, [resolved]);

  return <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>;
};
