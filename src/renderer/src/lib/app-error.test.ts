import { describe, expect, it } from "vite-plus/test";

import { toAppError } from "./app-error";

describe("toAppError", () => {
  it("maps read/load failures to the open-drawing copy", () => {
    const error = toAppError(new Error("ENOENT"), "read");
    expect(error.title).toBe("Couldn’t open this drawing");
    expect(error.message).toContain("unavailable, invalid, or too large");
    expect(error.operation).toBe("read");
    expect(error.retryable).toBe(true);
  });

  it("maps save failures to the persistent-save copy", () => {
    const error = toAppError(new Error("EACCES"), "save");
    expect(error.title).toBe("Couldn’t save this drawing");
    expect(error.message).toContain("still open in xdrawz");
  });

  it("maps recover failures and forces non-retryable", () => {
    const error = toAppError(new Error("nothing to recover"), "recover", false);
    expect(error.title).toBe("Couldn’t recover this drawing");
    expect(error.retryable).toBe(false);
  });

  it("maps unexpected failures", () => {
    const error = toAppError("boom", "unexpected");
    expect(error.title).toBe("Something went wrong");
    expect(error.retryable).toBe(true);
  });

  it("does not leak the raw IPC message into the copy title or body", () => {
    const error = toAppError(
      new Error("Error invoking remote method 'files:rename': Error: EACCES"),
      "rename",
    );
    expect(error.title).toBe("Couldn’t rename this drawing");
    expect(error.message).not.toContain("EACCES");
    expect(error.message).not.toContain("files:rename");
    expect(error.detail).toBe("EACCES");
  });

  it("keeps an already-unwrapped wire message in the detail", () => {
    const error = toAppError(
      new Error("Error invoking remote method 'files:write': Error: File not found"),
      "save",
    );
    expect(error.detail).toBe("File not found");
  });

  it("preserves unknown non-Error payloads as detail", () => {
    const error = toAppError({ code: 42 }, "delete");
    expect(error.detail).toBe("Unknown error");
  });

  it("builds a unique id per incident", () => {
    const a = toAppError(new Error("x"), "rename");
    const b = toAppError(new Error("x"), "rename");
    expect(a.id).not.toBe(b.id);
  });

  it("uses caller operation for copy selection", () => {
    const readError = toAppError(new Error("file not found"), "read");
    expect(readError.title).toBe("Couldn\u2019t open this drawing");

    const saveError = toAppError(new Error("permission denied"), "save");
    expect(saveError.title).toBe("Couldn\u2019t save this drawing");

    const settingsError = toAppError(new Error("invalid theme"), "settings");
    expect(settingsError.title).toBe("Couldn\u2019t update settings");
  });

  it("uses cleanErrorMessage for detail", () => {
    const error = toAppError(new Error("raw error message"), "save");
    expect(error.detail).toBe("raw error message");

    const withPrefix = toAppError(
      new Error("Error invoking remote method 'files:save': Error: disk full"),
      "save",
    );
    expect(withPrefix.detail).toBe("disk full");
  });
});
