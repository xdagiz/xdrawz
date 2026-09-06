import { cleanErrorMessage, isRecord, type ErrorOperation } from "@shared/errors";
import { FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";

export type AppError = {
  id: string;
  operation: ErrorOperation;
  title: string;
  message: string;
  retryable: boolean;
  detail: string;
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

  if (operation === "create") {
    return {
      title: "Couldn’t create this drawing",
      message: "Check that the drawings folder is available and try again.",
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

export const saveErrorToastId = (fileId: string) => `save:${fileId}`;

const toBasename = (clean: string) => clean.split(/[\\/]/).pop() ?? clean;

const stripPaths = (msg: string) => {
  let out = msg.replace(/['"]?\\\\[^'"\s]+['"]?/g, (m) => {
    const clean = m.replace(/^['"]|['"]$/g, "");
    return `'${toBasename(clean)}'`;
  });
  out = out.replace(/['"]?[A-Za-z]:\\[^'"\s]*['"]?/g, (m) => {
    const clean = m.replace(/^['"]|['"]$/g, "");
    return `'${toBasename(clean)}'`;
  });
  return out.replace(/['"]?\/[^'"\s]+['"]?/g, (m) => {
    const clean = m.replace(/^['"]|['"]$/g, "");
    return `'${toBasename(clean)}'`;
  });
};

const friendlyDetail = (error: unknown): string | null => {
  const raw = stripPaths(cleanErrorMessage(error));
  const code = isRecord(error) && typeof error.code === "string" ? error.code.toUpperCase() : "";

  if (code === "EACCES" || code === "EPERM" || /permission denied/i.test(raw)) {
    return "The drawings folder or file is not writable.";
  }

  if (code === "ENOSPC") return "The disk is full. Free up space and try again.";
  if (code === "EFBIG" || /Content exceeds \d+ bytes/.test(raw)) {
    return "The drawing exceeds the 10 MB size limit.";
  }

  if (code === "ENOENT" || code === "NOT_FOUND" || raw.includes(FILE_NOT_FOUND_MESSAGE)) {
    return "The file no longer exists on disk.";
  }

  return null;
};

export const toAppError = (
  error: unknown,
  operation: ErrorOperation = "unexpected",
  retryable = true,
  resourceId?: string,
): AppError => {
  const detail = friendlyDetail(error) ?? stripPaths(cleanErrorMessage(error));

  return {
    id: resourceId ? `${operation}:${resourceId}` : `${operation}:${detail}`,
    operation,
    retryable,
    detail,
    ...messageFor(operation),
  };
};
