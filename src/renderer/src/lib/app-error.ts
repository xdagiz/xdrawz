export type ErrorOperation =
  | "load"
  | "read"
  | "save"
  | "recover"
  | "rename"
  | "delete"
  | "settings"
  | "unexpected";

export type AppError = {
  id: string;
  operation: ErrorOperation;
  title: string;
  message: string;
  retryable: boolean;
  detail: string;
};

const copyableDetail = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown error";
};

const messageFor = (operation: ErrorOperation): Pick<AppError, "title" | "message"> => {
  if (operation === "read" || operation === "load") {
    return {
      title: "Couldn’t open this drawing",
      message: "The file may be unavailable, invalid, or too large to open.",
    };
  }

  if (operation === "save" || operation === "recover") {
    return {
      title:
        operation === "recover" ? "Couldn’t recover this drawing" : "Couldn’t save this drawing",
      message:
        "Your latest edits are still open in xdrawz. Check that the drawings folder is available and try again.",
    };
  }

  if (operation === "rename") {
    return {
      title: "Couldn’t rename this drawing",
      message: "Check that the folder is available and try again.",
    };
  }

  if (operation === "delete") {
    return {
      title: "Couldn’t delete this drawing",
      message: "Try again after checking folder access.",
    };
  }

  if (operation === "settings") {
    return { title: "Couldn’t update settings", message: "Your change was not saved. Try again." };
  }

  return {
    title: "Something went wrong",
    message: "Try again. If this keeps happening, copy the details for support.",
  };
};

export const toAppError = (
  error: unknown,
  operation: ErrorOperation,
  retryable = true,
): AppError => {
  const message = messageFor(operation);
  const detail = copyableDetail(error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

  return {
    id: `${operation}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    operation,
    retryable,
    detail,
    ...message,
  };
};
