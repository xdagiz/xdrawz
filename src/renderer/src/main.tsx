import "./assets/main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installRendererErrorHandlers } from "@/lib/report-error";

import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { Toaster } from "./components/ui/toast";
import { setCloseHandshakeActive } from "./lib/close-handshake";
import { reportRendererError } from "./lib/report-error";
import { sessionOwner } from "./lib/session-owner";
import { useStore } from "./lib/store";

installRendererErrorHandlers();

window.api.window.onWillClose((request) => {
  setCloseHandshakeActive(true);

  if (request.kind === "check") {
    const session = sessionOwner.getSession();
    const dirty = Object.keys(useStore.getState().dirtyById).length > 0;
    if (dirty) session?.setAutosavePaused(true);
    window.api.window.reportDirtyState(request.requestId, dirty);
    return;
  }

  void (async () => {
    window.api.window.flushStarted(request.requestId);
    const session = sessionOwner.getSession();
    try {
      if (session) await session.flush({ force: true });
    } catch (error) {
      reportRendererError(error, "save");
      window.api.window.cancelQuit(request.requestId);
      setCloseHandshakeActive(false);
      return;
    }

    if (session?.isDirty()) {
      window.api.window.cancelQuit(request.requestId);
      setCloseHandshakeActive(false);
      return;
    }

    await window.api.window.close(request.requestId);
    setCloseHandshakeActive(false);
  })();
});

window.api.window.onCloseCancelled(() => {
  setCloseHandshakeActive(false);
  sessionOwner.getSession()?.setAutosavePaused(false);
});

window.api.window.ready();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Toaster />
    <ErrorBoundary
      title="xdrawz couldn’t start"
      description="Try again. If this keeps happening, copy the details for support."
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
