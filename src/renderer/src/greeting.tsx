import "./assets/main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { readStoredTheme } from "@/lib/theme";

import { Greeting } from "./components/greeting";
import { ThemeProvider } from "./components/theme-provider";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider preference={readStoredTheme(window.localStorage)}>
      <Greeting />
    </ThemeProvider>
  </StrictMode>,
);
