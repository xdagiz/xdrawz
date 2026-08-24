import {
  isCancellationError,
  isResizeObserverLoopError,
  isSigPipeError,
  toSerialized,
  type ErrorOperation,
} from "@shared/errors";

import { toast } from "@/components/ui/toast";
import { toAppError } from "@/lib/app-error";

let installed = false;

const shouldSilence = (error: unknown): boolean => {
  if (isCancellationError(error)) return true;
  if (isResizeObserverLoopError(error)) return true;
  if (isSigPipeError(error)) return true;
  return false;
};

export const reportRendererError = (
  error: unknown,
  operation: ErrorOperation = "unexpected",
  opts?: { fatal?: boolean },
): void => {
  if (shouldSilence(error)) return;

  console.error(`${operation} error:`, error);

  const appError = toAppError(error, operation);

  toast.add({
    id: appError.id,
    title: appError.title,
    description: appError.detail,
    type: "error",
  });

  if (opts?.fatal) {
    const payload = toSerialized(error, operation);
    void window.api.window.reportFatal(payload).catch(() => {});
  }
};

export const installRendererErrorHandlers = (): void => {
  if (installed) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  installed = true;

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportRendererError(event.reason, "unexpected");
  });

  window.addEventListener("error", (event: ErrorEvent) => {
    if (event.error) reportRendererError(event.error, "unexpected");
  });
};

installRendererErrorHandlers();
