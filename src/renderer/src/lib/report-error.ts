import { isRecord, isSerializedAppError, toSerialized, type ErrorOperation } from "@shared/errors";

import { toast } from "@/components/ui/toast";
import { toAppError } from "@/lib/app-error";

let installed = false;

const isCancellationError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "Canceled" && error.message === "Canceled")
    return true;
  if (isSerializedAppError(error) && error.code === "CANCELLED") return true;
  if (isSerializedAppError(error) && error.name === "Canceled" && error.message === "Canceled")
    return true;
  return false;
};

const isResizeObserverLoopError = (error: unknown): boolean => {
  let message = "";

  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  else if (isSerializedAppError(error)) message = error.message;
  else if (isRecord(error) && typeof error.message === "string") message = error.message;

  return (
    message.includes("ResizeObserver loop completed with undelivered notifications") ||
    message.includes("ResizeObserver loop limit exceeded")
  );
};

const isSigPipeError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  if (!("code" in error)) return false;
  if (!("syscall" in error)) return false;
  const code = error.code;
  const syscall = error.syscall;
  return code === "EPIPE" && typeof syscall === "string" && syscall.toUpperCase() === "WRITE";
};

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
