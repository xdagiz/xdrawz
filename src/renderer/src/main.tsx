import "./assets/main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installRendererErrorHandlers } from "@/lib/report-error";

import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { Toaster, toast } from "./components/ui/toast";
import { createCloseFlow, waitForCanvasActionSettled } from "./lib/close-flow";
import {
  closeDecision,
  createBeforeUnloadGuard,
  setCloseHandshakeActive,
} from "./lib/close-handshake";
import { reportFatalToMain, reportRendererError } from "./lib/report-error";
import { sessionOwner } from "./lib/session-owner";
import { useStore } from "./lib/store";

installRendererErrorHandlers();

window.addEventListener(
  "beforeunload",
  createBeforeUnloadGuard(() => {
    const session = sessionOwner.getSession();
    session?.evaluateNow();
    const state = useStore.getState();
    const decision = closeDecision({
      visibleDirtyCount: Object.keys(state.dirtyById).length,
      sessionDirty: session?.isDirty() ?? false,
      scratchDirty: false,
      autosaveMode: state.settings.autosave.mode,
      hasConflict: state.externalConflict !== null,
    });
    return decision.mustFlush ? 1 : 0;
  }),
);

window.api.window.onWillClose(
  createCloseFlow({
    getState: useStore.getState,
    getSession: () => sessionOwner.getSession(),
    windowApi: window.api.window,
    waitForCanvasActionSettled: () =>
      waitForCanvasActionSettled(
        () => useStore.getState().pendingCanvasAction,
        (listener) =>
          useStore.subscribe((state) => {
            listener(state.pendingCanvasAction);
          }),
      ),
    addToast: toast.add,
    reportError: reportRendererError,
  }),
);

window.api.window.onCloseCancelled(() => {
  setCloseHandshakeActive(false);
  sessionOwner.getSession()?.setAutosavePaused(false);
});

window.api.window.ready();

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Toaster />
      <ErrorBoundary
        title="xcalidraw couldn’t start"
        description="Try again. If this keeps happening, copy the details for support."
      >
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (error) {
  reportFatalToMain(error);
}
