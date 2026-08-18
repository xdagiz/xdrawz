import "./assets/main.css";
import { cleanErrorMessage } from "@shared/errors";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./components/error-boundary";
import { Toaster } from "./components/ui/toast";
import { toast } from "./components/ui/toast";
import { toAppError } from "./lib/app-error";
import { useStore } from "./lib/store";
import { router } from "./router";

const DEDUP_WINDOW_MS = 1000;
let lastUnexpected: { message: string; at: number } | null = null;

const reportUnexpected = (error: unknown): void => {
  const message = cleanErrorMessage(error);
  const now = Date.now();

  if (
    lastUnexpected &&
    lastUnexpected.message === message &&
    now - lastUnexpected.at < DEDUP_WINDOW_MS
  ) {
    return;
  }
  lastUnexpected = { message, at: now };

  console.error("unexpected error:", error);
  const appError = toAppError(error, "unexpected");
  toast.add({
    title: appError.title,
    description: appError.detail,
    type: "error",
  });
};

window.addEventListener("unhandledrejection", (event) => {
  reportUnexpected(event.reason);
});

window.addEventListener("error", (event) => {
  if (event.error) reportUnexpected(event.error);
});

window.api.window.onWillClose((request) => {
  if (request.kind === "check") {
    const session = useStore.getState().activeSession;
    const dirty = Object.keys(useStore.getState().dirtyById).length > 0;
    if (dirty) session?.setAutosavePaused(true);
    window.api.window.reportDirtyState(request.requestId, dirty);
    return;
  }

  void (async () => {
    window.api.window.flushStarted(request.requestId);
    const session = useStore.getState().activeSession;
    try {
      if (session) await session.flush({ force: true });
    } catch (error) {
      console.error("failed to flush scene while closing:", error);
      useStore.getState().reportError(error, "save");
      window.api.window.cancelQuit(request.requestId);
      return;
    }

    if (session?.isDirty()) {
      window.api.window.cancelQuit(request.requestId);
      return;
    }

    await window.api.window.close(request.requestId);
  })();
});

window.api.window.onCloseCancelled(() => {
  useStore.getState().activeSession?.setAutosavePaused(false);
});

window.api.window.ready();

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
