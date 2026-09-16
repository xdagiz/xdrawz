import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { AutosaveSetting, FileEntry } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (elements: unknown, appState: unknown, files: unknown) =>
    JSON.stringify({ elements, appState, files }),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn() },
}));

import { createDrawingSession, type FrameScheduler } from "./drawing-session";
import { sessionOwner } from "./session-owner";
import { useStore } from "./store";

const fileId = "a.excalidraw";
const entry = (modifiedAt: number): FileEntry => ({
  id: fileId,
  name: fileId,
  kind: "file",
  parentId: null,
  modifiedAt,
  size: 100,
});
const appState = { isLoading: false, viewBackgroundColor: "#ffffff" } as AppState;
const elements = [{ id: "local-stroke", type: "rectangle" }] as OrderedExcalidrawElement[];
const files = {
  image: {
    id: "image",
    mimeType: "image/png",
    dataURL: "data:image/png;base64,bG9jYWw=",
    created: 1,
  },
} as unknown as BinaryFiles;
const write = vi.fn<(id: string, content: string) => Promise<FileEntry>>();
let revision = 0;
const externalEvent = (kind: "changed" | "missing") => ({
  entries: kind === "changed" ? [entry(200)] : [],
  revision: ++revision,
  root: "/drawings",
});

const neverFireFrame: FrameScheduler = () => () => {};

const openSession = (id = fileId, initialAutosave?: AutosaveSetting) => {
  const session = sessionOwner.acquire(
    id,
    createDrawingSession({
      fileId: id,
      save: (sid, content, origin) => useStore.getState().saveFile(sid, content, origin),
      onDirtyChange: (sid, dirty) => useStore.getState().setFileDirty(sid, dirty),
      initialAutosave,
      scheduleFrame: neverFireFrame,
    }),
  );
  session.onChange([], appState, {});
  return { session };
};

beforeEach(() => {
  revision += 2;
  vi.useFakeTimers();
  write.mockReset().mockResolvedValue(entry(150));
  vi.stubGlobal("window", { api: { files: { write } } });
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ entries: [entry(100)], openFileId: fileId, editorGeneration: 7 });
});

afterEach(() => {
  sessionOwner.releaseActive();
  useStore.setState(useStore.getInitialState(), true);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("applyEntries with drawing sessions", () => {
  it("retains an unevaluated always-autosave edit when the open file changes externally", () => {
    const { session } = openSession();
    session.onChange(elements, appState, files);
    expect(session.isDirty()).toBe(false);
    expect(useStore.getState().dirtyById).toEqual({});

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toEqual({
      type: "changed",
      fileId,
      diskModifiedAt: 200,
    });
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(7);
    expect(session.isDirty()).toBe(true);
    expect(JSON.parse(session.getSerializedContent()!)).toEqual({ elements, appState, files });
  });

  it("uses clean behavior after the latest edit has been saved successfully", async () => {
    const { session } = openSession();
    session.onChange(elements, appState, files);
    expect(await session.saveNow()).toBe(true);
    expect(session.isDirty()).toBe(false);
    useStore.getState().setFileDirty(fileId, true);

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toBeNull();
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(8);
  });

  it.each([false, true])("uses marker fallback without a matching session: marker %s", (dirty) => {
    openSession("b.excalidraw");
    useStore.getState().setFileDirty(fileId, dirty);

    useStore.getState().applyEntries(externalEvent("changed"));

    expect(useStore.getState().externalConflict).toEqual(
      dirty ? { type: "changed", fileId, diskModifiedAt: 200 } : null,
    );
    expect(useStore.getState().openFileId).toBe(fileId);
    expect(useStore.getState().editorGeneration).toBe(dirty ? 7 : 8);
  });
});
