import { useContext } from "react";

import { ThemeContext } from "@/components/theme-context";

export const useTheme = () => useContext(ThemeContext);
