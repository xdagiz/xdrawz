import type { WindowCloseRequest } from "@shared/ipc";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SceneSessionControls } from "./lib/scene-session";
import { useStore } from "./lib/store";

const hoisted = vi.hoisted(() => ({
  createRoot: vi.fn(() => ({ render: vi.fn() })),
  addEventListener: vi.fn(),
  getElementById: vi.fn(() => ({})),
  localStorageGetItem: vi.fn(() => null),
  api: {
    window: {
      onWillClose: vi.fn(),
      onCloseCancelled: vi.fn(),
      ready: vi.fn(),
      close: vi.fn(),
      cancelQuit: vi.fn(),
      reportDirtyState: vi.fn(),
      flushStarted: vi.fn(),
    },
  },
}));

vi.mock("react-dom/client", () => ({ createRoot: hoisted.createRoot }));
vi.mock("./router", () => ({ RouterProvider: () => null, router: {} }));
vi.mock("./components/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./components/ui/toast", () => ({ Toaster: () => null, toast: { add: vi.fn() } }));

let onWillClose: (request: WindowCloseRequest) => void;
let onCloseCancelled: () => void;
let consoleError: ReturnType<typeof vi.spyOn>;

type FakeSession = SceneSessionControls & {
  setAutosavePaused: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  isDirty: ReturnType<typeof vi.fn>;
};

const fakeSession = (): FakeSession => {
  const session = {
    setAutosavePaused: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    isDirty: vi.fn().mockReturnValue(false),
  };
  return session as unknown as FakeSession;
};

const expectAutosave = (session: SceneSessionControls) =>
  session.setAutosavePaused as unknown as ReturnType<typeof vi.fn>;

describe("window close flow (renderer)", () => {
  beforeAll(async () => {
    vi.stubGlobal("window", {
      addEventListener: hoisted.addEventListener,
      localStorage: { getItem: hoisted.localStorageGetItem, setItem: vi.fn() },
      api: hoisted.api,
    });
    vi.stubGlobal("document", { getElementById: hoisted.getElementById });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./main");

    const [willCloseCb] = hoisted.api.window.onWillClose.mock.calls[0] ?? [];
    const [cancelledCb] = hoisted.api.window.onCloseCancelled.mock.calls[0] ?? [];
    if (typeof willCloseCb !== "function" || typeof cancelledCb !== "function") {
      throw new Error("close handlers were not registered by main.tsx");
    }
    onWillClose = willCloseCb;
    onCloseCancelled = cancelledCb;
  });

  afterAll(() => {
    consoleError.mockRestore();
  });

  beforeEach(() => {
    useStore.setState({ activeSession: null, dirtyById: {} });
    for (const mock of Object.values(hoisted.api.window)) mock.mockClear();
  });

  it("reports clean without pausing autosave", () => {
    const session = fakeSession();
    useStore.setState({ activeSession: session, dirtyById: {} });

    onWillClose({ requestId: 7, kind: "check" });

    expect(hoisted.api.window.reportDirtyState).toHaveBeenCalledWith(7, false);
    expect(expectAutosave(session)).not.toHaveBeenCalled();
  });

  it("pauses autosave when the check reports dirty", () => {
    const session = fakeSession();
    useStore.setState({ activeSession: session, dirtyById: { f1: true } });

    onWillClose({ requestId: 7, kind: "check" });

    expect(hoisted.api.window.reportDirtyState).toHaveBeenCalledWith(7, true);
    expect(expectAutosave(session)).toHaveBeenCalledWith(true);
  });

  it("closes after a flush that persists the scene", async () => {
    const session = fakeSession();
    session.isDirty.mockReturnValue(false);
    useStore.setState({ activeSession: session, dirtyById: { f1: true } });

    onWillClose({ requestId: 9, kind: "flush" });

    await vi.waitFor(() => expect(hoisted.api.window.close).toHaveBeenCalledWith(9));
    expect(hoisted.api.window.flushStarted).toHaveBeenCalledWith(9);
    expect(hoisted.api.window.cancelQuit).not.toHaveBeenCalled();
  });

  it("aborts the close when the flush fails to persist the scene", async () => {
    // flush() resolves without throwing when the write fails, leaving the
    // session dirty; the window must not close in that case.
    const session = fakeSession();
    session.flush.mockResolvedValue(undefined);
    session.isDirty.mockReturnValue(true);
    useStore.setState({ activeSession: session, dirtyById: { f1: true } });

    onWillClose({ requestId: 9, kind: "flush" });

    await vi.waitFor(() => expect(hoisted.api.window.cancelQuit).toHaveBeenCalledWith(9));
    expect(hoisted.api.window.close).not.toHaveBeenCalled();
  });

  it("cancels the close when the flush throws and reports the error", async () => {
    const session = fakeSession();
    session.flush.mockRejectedValue(new Error("boom"));
    useStore.setState({ activeSession: session, dirtyById: { f1: true } });

    onWillClose({ requestId: 9, kind: "flush" });

    await vi.waitFor(() => expect(hoisted.api.window.cancelQuit).toHaveBeenCalledWith(9));
    expect(hoisted.api.window.close).not.toHaveBeenCalled();
    expect(useStore.getState().error).not.toBeNull();
  });

  it("resumes autosave when the close flow is cancelled", () => {
    const session = fakeSession();
    useStore.setState({ activeSession: session });

    onCloseCancelled();

    expect(expectAutosave(session)).toHaveBeenCalledWith(false);
  });
});
