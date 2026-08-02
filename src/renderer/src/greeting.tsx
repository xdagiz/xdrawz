import "./assets/main.css";
import { DEFAULT_THEME, type ThemePreference } from "@shared/ipc";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Greeting } from "./components/greeting";
import { ThemeProvider } from "./components/theme-provider";

const bootPreference = (): ThemePreference => {
  try {
    return window.api.settings.getBoot().theme;
  } catch {
    return DEFAULT_THEME;
  }
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider preference={bootPreference()}>
      <Greeting />
    </ThemeProvider>
  </StrictMode>,
);
