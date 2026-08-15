import "./assets/main.css";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./components/error-boundary";
import { Toaster, toast } from "./components/ui/toast";
import { router } from "./router";

const reportUnexpected = (error: unknown) => {
  console.error("unexpected error:", error);
  toast.add({
    title: "Something went wrong",
    description: "The app recovered. If this keeps happening, restart xdrawz.",
    type: "error",
  });
};

window.addEventListener("unhandledrejection", (event) => {
  reportUnexpected(event.reason);
});

window.addEventListener("error", (event) => {
  if (event.error) reportUnexpected(event.error);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toaster />
    <ErrorBoundary
      title="xdrawz couldn’t start"
      description="Try again. If this keeps happening, copy the details for support."
    >
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);
