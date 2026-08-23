export type ErrorOperation =
  | "load"
  | "read"
  | "save"
  | "recover"
  | "rename"
  | "create"
  | "delete"
  | "settings"
  | "unexpected";

export type ErrorCode = "NOT_FOUND" | "TOO_LARGE" | "INVALID" | "CANCELLED" | "UNKNOWN";

export type Result<T> = { ok: true; value: T } | { ok: false; error: SerializedAppError };

export interface SerializedAppError {
  readonly $isAppError: true;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: ErrorCode;
  readonly operation?: ErrorOperation;
  readonly retryable: boolean;
  readonly cause?: SerializedAppError;
}

const IPC_PREFIX_PATTERN = /^Error invoking remote method '[^']+': (Error: )?/;

const ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "TOO_LARGE",
  "INVALID",
  "CANCELLED",
  "UNKNOWN",
]);

const ERROR_OPERATIONS: ReadonlySet<string> = new Set([
  "load",
  "read",
  "save",
  "recover",
  "rename",
  "create",
  "delete",
  "settings",
  "unexpected",
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const errorWithCode = (message: string, code: ErrorCode): Error => {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
};

const normalizeMessage = (value: string): string => {
  const cleaned = value.replace(IPC_PREFIX_PATTERN, "");
  return cleaned.trim();
};

export const cleanErrorMessage = (error: unknown): string => {
  if (isSerializedAppError(error)) {
    const cleaned = normalizeMessage(error.message);
    return cleaned ? cleaned : "Unknown error";
  }

  let message = "";

  if (error instanceof Error) message = error.message;
  else if (typeof error === "string") message = error;
  else if (isRecord(error) && typeof error.message === "string") message = error.message;

  const cleaned = normalizeMessage(message);
  return cleaned ? cleaned : "Unknown error";
};

export const isSerializedAppError = (value: unknown): value is SerializedAppError => {
  if (!isRecord(value)) return false;
  if (!("$isAppError" in value)) return false;
  if (!("message" in value)) return false;
  if (!("name" in value)) return false;
  if (!("code" in value)) return false;
  if (!("retryable" in value)) return false;
  const isApp = value.$isAppError === true;
  const msg = value.message;
  const name = value.name;
  const code = value.code;
  const retryable = value.retryable;
  const operation = value.operation;
  return (
    isApp &&
    typeof msg === "string" &&
    typeof name === "string" &&
    typeof code === "string" &&
    ERROR_CODES.has(code) &&
    typeof retryable === "boolean" &&
    (operation === undefined || (typeof operation === "string" && ERROR_OPERATIONS.has(operation)))
  );
};

const toErrorCode = (error: unknown): ErrorCode => {
  if (isRecord(error) && "code" in error) {
    const code = error.code;
    if (
      code === "NOT_FOUND" ||
      code === "TOO_LARGE" ||
      code === "INVALID" ||
      code === "CANCELLED"
    ) {
      return code;
    }
    if (typeof code === "string" && code.length > 0) {
      const upper = code.toUpperCase();
      if (upper === "NOT_FOUND" || upper === "ENOENT") return "NOT_FOUND";
      if (upper === "TOO_LARGE" || upper === "EFBIG") return "TOO_LARGE";
      if (upper === "INVALID" || upper === "EINVAL") return "INVALID";
      if (upper === "CANCELLED" || upper === "ECANCELED") return "CANCELLED";
    }
  }

  return "UNKNOWN";
};

const getStack = (error: unknown): string | undefined => {
  if (isRecord(error) && typeof error.stack === "string" && error.stack.length > 0)
    return error.stack;
  return undefined;
};

const getCause = (error: unknown): unknown => {
  if (isRecord(error) && "cause" in error) return error.cause;
  return undefined;
};

const getOperation = (error: unknown): ErrorOperation | undefined => {
  if (isRecord(error) && typeof error.operation === "string") {
    const op = error.operation;
    if (
      op === "load" ||
      op === "read" ||
      op === "save" ||
      op === "recover" ||
      op === "rename" ||
      op === "create" ||
      op === "delete" ||
      op === "settings" ||
      op === "unexpected"
    )
      return op;
  }
  return undefined;
};

const getRetryable = (error: unknown): boolean | undefined => {
  if (isRecord(error) && typeof error.retryable === "boolean") return error.retryable;
  return undefined;
};

const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "NOT_FOUND",
  "TOO_LARGE",
  "INVALID",
  "CANCELLED",
]);

export const toSerialized = (
  error: unknown,
  operation: ErrorOperation = "unexpected",
  retryable?: boolean,
): SerializedAppError => {
  if (isSerializedAppError(error)) {
    return error;
  }

  const message = cleanErrorMessage(error);
  const stack = getStack(error);
  const code = toErrorCode(error);
  const causeRaw = getCause(error);
  const storedOperation = getOperation(error);
  const storedRetryable = getRetryable(error);
  const effectiveOperation = storedOperation ?? operation;
  const effectiveRetryable = storedRetryable ?? retryable ?? !NON_RETRYABLE.has(code);

  let name = "Error";

  if (isRecord(error) && typeof error.name === "string" && error.name.length > 0) name = error.name;

  let cause: SerializedAppError | undefined;

  if (causeRaw instanceof Error || isSerializedAppError(causeRaw) || typeof causeRaw === "string") {
    if (causeRaw instanceof Error || typeof causeRaw === "string") {
      cause = toSerialized(causeRaw, effectiveOperation, effectiveRetryable);
    } else {
      cause = causeRaw;
    }
  }

  return {
    $isAppError: true,
    name,
    message,
    stack,
    code,
    operation: effectiveOperation,
    retryable: effectiveRetryable,
    cause,
  };
};

export const fromSerialized = (serialized: SerializedAppError): Error => {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  Object.assign(error, { code: serialized.code });
  Object.assign(error, { operation: serialized.operation });
  Object.assign(error, { retryable: serialized.retryable });
  if (serialized.cause) Object.assign(error, { cause: fromSerialized(serialized.cause) });
  return error;
};

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

export const isCancellationError = (error: unknown): boolean => {
  if (error instanceof CancellationError) return true;
  if (error instanceof Error && error.name === "Canceled" && error.message === "Canceled")
    return true;
  if (isSerializedAppError(error) && error.code === "CANCELLED") return true;
  if (isSerializedAppError(error) && error.name === "Canceled" && error.message === "Canceled")
    return true;
  return false;
};

export const isResizeObserverLoopError = (error: unknown): boolean => {
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

export const isSigPipeError = (error: unknown): boolean => {
  if (!isRecord(error)) return false;
  if (!("code" in error)) return false;
  if (!("syscall" in error)) return false;
  const code = error.code;
  const syscall = error.syscall;
  return code === "EPIPE" && typeof syscall === "string" && syscall.toUpperCase() === "WRITE";
};
