import type { ResolvedTheme } from "@shared/theme";
import { createContext } from "react";

export const ThemeContext = createContext<ResolvedTheme>("light");
