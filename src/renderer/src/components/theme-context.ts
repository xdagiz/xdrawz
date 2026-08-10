import { createContext } from "react";

import type { ResolvedTheme } from "@/lib/theme";

export const ThemeContext = createContext<ResolvedTheme>("light");
