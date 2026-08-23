import type { FileEntry, ThumbnailRecord } from "@shared/ipc";
import { describe, expect, it, vi } from "vite-plus/test";

import { createThumbnailStore, type ThumbnailPair } from "./thumbnails";

const entry = (id: string, modifiedAt = 100, size = 10): FileEntry => ({
  id,
  name: id,
  kind: "file",
  parentId: null,
  modifiedAt,
  size,
});

const pair = {
  light: "data:image/png;base64,AAAA",
  dark: "data:image/png;base64,BBBB",
};

const makeDeps = () => ({
  apiFetch: vi.fn(async (_ids: string[]) => [] as ThumbnailRecord[]),
  apiPut: vi.fn(async (_record: ThumbnailRecord) => {}),
  generate: vi.fn(async (_fileId: string) => pair),
});

describe("thumbnail store", () => {
  it("hydrate merges fetched records and notifies subscribers", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);
    const listener = vi.fn();
    store.subscribe(listener);

    deps.apiFetch.mockResolvedValue([{ fileId: "a.excalidraw", mtimeMs: 100, size: 10, ...pair }]);

    await store.hydrate([entry("a.excalidraw"), entry("b.excalidraw")]);

    expect(store.getRecord("a.excalidraw")?.light).toBe(pair.light);
    expect(store.getRecord("b.excalidraw")).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it("syncWithEntries enqueues exactly the stale set and skips fresh records", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    deps.apiFetch.mockResolvedValue([
      { fileId: "fresh.excalidraw", mtimeMs: 100, size: 10, ...pair },
    ]);
    await store.hydrate([entry("fresh.excalidraw")]);
    deps.generate.mockClear();

    store.syncWithEntries([entry("fresh.excalidraw"), entry("stale.excalidraw", 200, 20)]);

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledTimes(1);
      expect(deps.generate).toHaveBeenCalledWith("stale.excalidraw");
    });
  });

  it("keeps generating after an individual failure", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);
    deps.generate.mockRejectedValueOnce(new Error("boom"));

    store.syncWithEntries([entry("bad.excalidraw"), entry("good.excalidraw")]);

    await vi.waitFor(() => {
      expect(deps.apiPut).toHaveBeenCalledTimes(1);
      expect(store.getRecord("good.excalidraw")).toBeDefined();
    });
    expect(store.getRecord("bad.excalidraw")).toBeUndefined();
  });

  it("cancelPending stops the queue before later jobs run", async () => {
    const deps = makeDeps();
    let releaseFirst: (() => void) | undefined;
    deps.generate.mockImplementation(
      (fileId: string) =>
        new Promise((resolvePromise, rejectPromise) => {
          if (fileId === "slow.excalidraw") {
            releaseFirst = () => resolvePromise(pair);
          } else {
            rejectPromise(new Error("should not run"));
          }
        }),
    );

    const store = createThumbnailStore(deps);
    store.syncWithEntries([entry("slow.excalidraw"), entry("next.excalidraw")]);

    expect(store.isPending("next.excalidraw")).toBe(true);
    store.cancelPending();
    releaseFirst?.();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(store.isPending("next.excalidraw")).toBe(false);
    expect(store.getRecord("next.excalidraw")).toBeUndefined();
  });

  it("runs work enqueued while a cancelled generation is still in flight", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);
    let releaseFirst: (() => void) | undefined;
    deps.generate.mockImplementation((fileId: string) => {
      if (fileId === "slow.excalidraw") {
        return new Promise<ThumbnailPair>((resolvePromise) => {
          releaseFirst = () => resolvePromise(pair);
        });
      }
      return Promise.resolve(pair);
    });

    store.syncWithEntries([entry("slow.excalidraw")]);
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    store.cancelPending();
    store.syncWithEntries([entry("next.excalidraw")]);
    releaseFirst?.();

    await vi.waitFor(() => {
      expect(store.getRecord("next.excalidraw")).toBeDefined();
    });
    expect(store.isPending("next.excalidraw")).toBe(false);
  });

  it("re-sync with a changed mtime regenerates and replaces the record", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.syncWithEntries([entry("doc.excalidraw", 100)]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(1));

    store.syncWithEntries([entry("doc.excalidraw", 200, 99)]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(2));
    expect(store.getRecord("doc.excalidraw")?.mtimeMs).toBe(200);
  });
});
