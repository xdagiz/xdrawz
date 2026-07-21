import "./assets/main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Greeting } from "./components/greeting";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Greeting />
  </StrictMode>,
);
