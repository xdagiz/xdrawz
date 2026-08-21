import { describe, expect, it } from "vite-plus/test";

import { toAppError } from "./app-error";

describe("toAppError", () => {
  it("maps each operation to its user-facing copy", () => {
    expect(toAppError(new Error("ENOENT"), "read").title).toBe("Couldn’t open this drawing");
    expect(toAppError(new Error("EACCES"), "save").title).toBe("Couldn’t save this drawing");
    expect(toAppError(new Error("x"), "recover", false).title).toBe(
      "Couldn’t recover this drawing",
    );
    expect(toAppError(new Error("x"), "rename").title).toBe("Couldn’t rename this drawing");
    expect(toAppError(new Error("x"), "delete").title).toBe("Couldn’t delete this drawing");
    expect(toAppError(new Error("x"), "settings").title).toBe("Couldn’t update settings");
    expect(toAppError(new Error("x"), "unexpected").title).toBe("Something went wrong");
  });

  it("keeps the retryable flag from the caller", () => {
    expect(toAppError(new Error("x"), "read").retryable).toBe(true);
    expect(toAppError(new Error("x"), "recover", false).retryable).toBe(false);
  });

  it("strips the IPC error prefix for the detail without leaking it", () => {
    const error = toAppError(
      new Error("Error invoking remote method 'files:rename': Error: EACCES"),
      "rename",
    );

    expect(error.detail).toBe("EACCES");
    expect(error.message).not.toContain("EACCES");
    expect(error.message).not.toContain("files:rename");
  });

  it("builds a unique id per incident and handles non-Error payloads", () => {
    const a = toAppError(new Error("x"), "rename");
    const b = toAppError(new Error("x"), "rename");
    expect(a.id).not.toBe(b.id);

    expect(toAppError({ code: 42 }, "delete").detail).toBe("Unknown error");
  });
});
