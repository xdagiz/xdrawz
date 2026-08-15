export type ErrorOperation =
  | "load"
  | "read"
  | "save"
  | "recover"
  | "rename"
  | "delete"
  | "settings"
  | "unexpected";

const IPC_PREFIX_PATTERN = /^Error invoking remote method '[^']+': (Error: )?/;

export const cleanErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = message.replace(IPC_PREFIX_PATTERN, "");
  return cleaned.trim() ? cleaned : "Unknown error";
};
