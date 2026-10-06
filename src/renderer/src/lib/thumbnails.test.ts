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
  ino: "1",
  dev: "1",
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

    deps.apiFetch.mockResolvedValue([
      { fileId: "a.excalidraw", mtimeMs: 100, size: 10, ino: "1", dev: "1", ...pair },
    ]);

    await store.hydrate([entry("a.excalidraw"), entry("b.excalidraw")]);

    expect(store.getRecord("a.excalidraw")?.light).toBe(pair.light);
    expect(store.getRecord("b.excalidraw")).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });

  it("syncWithEntries enqueues exactly the stale set and skips fresh records", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    deps.apiFetch.mockResolvedValue([
      { fileId: "fresh.excalidraw", mtimeMs: 100, size: 10, ino: "1", dev: "1", ...pair },
    ]);
    await store.hydrate([entry("fresh.excalidraw")]);
    deps.generate.mockClear();

    store.setVisible("stale.excalidraw", true);
    store.syncWithEntries([entry("fresh.excalidraw"), entry("stale.excalidraw", 200, 20)]);

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledTimes(1);
      expect(deps.generate).toHaveBeenCalledWith("stale.excalidraw");
    });
  });

  it("does not enqueue generation for entries never marked visible", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.syncWithEntries([entry("hidden.excalidraw")]);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(deps.generate).not.toHaveBeenCalled();
    expect(store.isPending("hidden.excalidraw")).toBe(false);

    store.setVisible("hidden.excalidraw", true);

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledWith("hidden.excalidraw");
    });
  });

  it("generates once visibility arrives later and re-queues skipped work", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.syncWithEntries([entry("late.excalidraw"), entry("kept.excalidraw")]);
    store.setVisible("kept.excalidraw", true);

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledTimes(1);
      expect(deps.generate).toHaveBeenCalledWith("kept.excalidraw");
    });

    store.setVisible("late.excalidraw", true);

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledTimes(2);
      expect(deps.generate).toHaveBeenCalledWith("late.excalidraw");
    });
  });

  it("force generates immediately without visibility", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.force(entry("focus.excalidraw", 300, 30));

    await vi.waitFor(() => {
      expect(deps.generate).toHaveBeenCalledWith("focus.excalidraw");
      expect(store.getRecord("focus.excalidraw")).toBeDefined();
    });
  });

  it("force is a no-op when the record already covers the entry", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.force(entry("covered.excalidraw"));
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledTimes(1));

    store.force(entry("covered.excalidraw"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it("keeps generating after an individual failure", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);
    deps.generate.mockRejectedValueOnce(new Error("boom"));

    store.setVisible("bad.excalidraw", true);
    store.setVisible("good.excalidraw", true);
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
    store.setVisible("slow.excalidraw", true);
    store.setVisible("next.excalidraw", true);
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

    store.setVisible("slow.excalidraw", true);
    store.setVisible("next.excalidraw", true);
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

    store.setVisible("doc.excalidraw", true);
    store.syncWithEntries([entry("doc.excalidraw", 100)]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(1));

    store.syncWithEntries([entry("doc.excalidraw", 200, 99)]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(2));
    expect(store.getRecord("doc.excalidraw")?.mtimeMs).toBe(200);
  });

  it("re-sync with the same mtime and size but a new inode regenerates", async () => {
    const deps = makeDeps();
    const store = createThumbnailStore(deps);

    store.setVisible("doc.excalidraw", true);
    store.syncWithEntries([{ ...entry("doc.excalidraw", 100), ino: "1", dev: "1" }]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(1));

    store.syncWithEntries([{ ...entry("doc.excalidraw", 100), ino: "2", dev: "1" }]);
    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(2));
    expect(store.getRecord("doc.excalidraw")?.ino).toBe("2");
  });

  it("regenerates a replacement that arrives while its id is in flight", async () => {
    const deps = makeDeps();
    let releaseFirst: (() => void) | undefined;
    deps.generate.mockImplementation(
      (fileId: string) =>
        new Promise<ThumbnailPair>((resolvePromise) => {
          if (fileId === "doc.excalidraw" && releaseFirst === undefined) {
            releaseFirst = () => resolvePromise(pair);
          } else {
            resolvePromise(pair);
          }
        }),
    );
    const store = createThumbnailStore(deps);

    store.setVisible("doc.excalidraw", true);
    store.syncWithEntries([{ ...entry("doc.excalidraw", 100), ino: "1", dev: "1" }]);
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());

    store.syncWithEntries([{ ...entry("doc.excalidraw", 100), ino: "2", dev: "1" }]);
    releaseFirst?.();

    await vi.waitFor(() => expect(deps.apiPut).toHaveBeenCalledTimes(2));
    expect(store.getRecord("doc.excalidraw")?.ino).toBe("2");
  });

  it("force during in-flight hydration skips regeneration when the hydrated record covers", async () => {
    const deps = makeDeps();
    let releaseFetch: ((records: ThumbnailRecord[]) => void) | undefined;
    deps.apiFetch.mockImplementation(
      () =>
        new Promise<ThumbnailRecord[]>((resolvePromise) => {
          releaseFetch = resolvePromise;
        }),
    );
    const store = createThumbnailStore(deps);
    const target = entry("race.excalidraw");

    const hydration = store.hydrate([target]);
    store.force(target);
    releaseFetch?.([
      {
        fileId: target.id,
        mtimeMs: target.modifiedAt,
        size: target.size,
        ino: target.ino,
        dev: target.dev,
        ...pair,
      },
    ]);
    await hydration;

    await vi.waitFor(() => {
      expect(store.getRecord(target.id)).toBeDefined();
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(deps.generate).not.toHaveBeenCalled();
  });
});
