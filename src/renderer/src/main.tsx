import "./assets/main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installRendererErrorHandlers } from "@/lib/report-error";

import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { Toaster } from "./components/ui/toast";
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
      hasConflict: state.externalConflict !== null,
    });
    return decision.mustFlush ? 1 : 0;
  }),
);

const CANVAS_ACTION_WAIT_MS = 4000;

const waitForCanvasActionSettled = () =>
  new Promise<void>((resolve) => {
    if (!useStore.getState().pendingCanvasAction) {
      resolve();
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (!useStore.getState().pendingCanvasAction) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started >= CANVAS_ACTION_WAIT_MS) {
        clearInterval(timer);
        console.warn("[close] canvas action did not settle before quit");
        resolve();
      }
    }, 50);
  });

window.api.window.onWillClose((request) => {
  setCloseHandshakeActive(true);

  if (request.kind === "check") {
    const session = sessionOwner.getSession();
    session?.evaluateNow();
    const state = useStore.getState();
    const decision = closeDecision({
      visibleDirtyCount: Object.keys(state.dirtyById).length,
      sessionDirty: session?.isDirty() ?? false,
      hasConflict: state.externalConflict !== null,
    });
    if (decision.mustFlush) session?.setAutosavePaused(true);
    window.api.window.reportDirtyState(request.requestId, decision.mustFlush, decision.skipPrompt);
    return;
  }

  void (async () => {
    window.api.window.flushStarted(request.requestId);
    if (useStore.getState().pendingCanvasAction) {
      await waitForCanvasActionSettled();
    }
    const session = sessionOwner.getSession();
    try {
      if (session) await session.flush({ force: true, explicit: true });
    } catch (error) {
      reportRendererError(error, "save");
      window.api.window.cancelQuit(request.requestId);
      setCloseHandshakeActive(false);
      return;
    }

    if (session?.isDirty()) {
      window.api.window.cancelQuit(request.requestId);
      setCloseHandshakeActive(false);
      const state = useStore.getState();
      if (state.externalConflict?.type === "changed") {
        void state.resolveChangedConflict({ force: true });
      } else if (state.externalConflict?.type === "missing") {
        void state.resolveMissingConflict(undefined, { force: true });
      }
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

try {
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
} catch (error) {
  reportFatalToMain(error);
}
