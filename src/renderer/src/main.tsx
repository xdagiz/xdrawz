import "./assets/main.css";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installRendererErrorHandlers } from "@/lib/report-error";

import { ErrorBoundary } from "./components/error-boundary";
import { Toaster } from "./components/ui/toast";
import { reportRendererError } from "./lib/report-error";
import { useStore } from "./lib/store";
import { router } from "./router";

installRendererErrorHandlers();

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
      reportRendererError(error, "save");
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
