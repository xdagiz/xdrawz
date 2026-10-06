import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/mock-user-data",
  },
}));

vi.mock("./drawings", () => ({
  getDrawings: async () => ({ configured: false, path: null }),
}));

import {
  decodeThumbnailKey,
  getThumbnailCacheDir,
  isValidThumbnailRecord,
  MAX_THUMBNAIL_DATA_URL_CHARS,
  pruneThumbnailCache,
  readThumbnailRecords,
  thumbnailKey,
  writeThumbnailRecord,
} from "./thumbnails";

const PNG_PREFIX = "data:image/png;base64,";

const oversizedDataUrl = (prefix: string) => `${prefix}${"A".repeat(MAX_THUMBNAIL_DATA_URL_CHARS)}`;

const longId = `${"a/".repeat(80)}drawing.excalidraw`;

const record = (fileId: string) => ({
  fileId,
  mtimeMs: 100,
  size: 10,
  light: "data:image/png;base64,AAAA",
  dark: "data:image/png;base64,BBBB",
});

describe("thumbnails cache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "xcalidraw-thumbs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds stable base64url keys that decode back to the id", () => {
    const id = "nested folder/naïve drawing.excalidraw";
    const key = thumbnailKey(id);
    expect(key.endsWith(".json")).toBe(true);
    expect(key.includes("=")).toBe(false);
    expect(thumbnailKey(id)).toBe(key);
    expect(decodeThumbnailKey(key)).toBe(id);
    expect(getThumbnailCacheDir()).toBe(path.join("/mock-user-data", "thumbnails"));
  });

  it("roundtrips records through write and read", async () => {
    await writeThumbnailRecord(record("a.excalidraw"), { cacheDir: dir });

    const hits = await readThumbnailRecords(["a.excalidraw", "missing.excalidraw"], {
      cacheDir: dir,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.fileId).toBe("a.excalidraw");
    expect(hits[0]?.light).toBe(record("a.excalidraw").light);
  });

  it("skips corrupt or malformed record files instead of throwing", async () => {
    await writeThumbnailRecord(record("good.excalidraw"), { cacheDir: dir });
    await writeFile(path.join(dir, thumbnailKey("bad.excalidraw")), "{not json");
    await writeFile(
      path.join(dir, thumbnailKey("wrong-shape.excalidraw")),
      JSON.stringify({ fileId: "x" }),
    );

    const hits = await readThumbnailRecords(
      ["good.excalidraw", "bad.excalidraw", "wrong-shape.excalidraw"],
      { cacheDir: dir },
    );
    expect(hits.map((r) => r.fileId)).toEqual(["good.excalidraw"]);
  });

  describe("isValidThumbnailRecord", () => {
    it("accepts records whose data urls are within the cap", () => {
      expect(isValidThumbnailRecord(record("a.excalidraw"))).toBe(true);
    });

    it("accepts records with optional file identity", () => {
      expect(isValidThumbnailRecord({ ...record("a.excalidraw"), ino: "1", dev: "1" })).toBe(true);
    });

    it("rejects records with a missing or wrong png prefix", () => {
      expect(
        isValidThumbnailRecord({ ...record("a.excalidraw"), light: "data:image/jpeg;base64,AA" }),
      ).toBe(false);
      expect(isValidThumbnailRecord({ ...record("a.excalidraw"), dark: 42 })).toBe(false);
    });

    it("rejects oversized light and dark payloads", () => {
      expect(
        isValidThumbnailRecord({ ...record("a.excalidraw"), light: oversizedDataUrl(PNG_PREFIX) }),
      ).toBe(false);
      expect(
        isValidThumbnailRecord({ ...record("a.excalidraw"), dark: oversizedDataUrl(PNG_PREFIX) }),
      ).toBe(false);
    });
  });

  it("prunes records whose ids are no longer valid and keeps the rest", async () => {
    await writeThumbnailRecord(record("keep.excalidraw"), { cacheDir: dir });
    await writeThumbnailRecord(record("gone/deleted.excalidraw"), { cacheDir: dir });
    await writeFile(path.join(dir, "garbage-name.json"), "{}");

    const result = await pruneThumbnailCache(new Set(["keep.excalidraw"]), 2000, {
      cacheDir: dir,
    });

    expect(result.removed).toBe(2);
    const remaining = await readThumbnailRecords(["keep.excalidraw", "gone/deleted.excalidraw"], {
      cacheDir: dir,
    });
    expect(remaining.map((r) => r.fileId)).toEqual(["keep.excalidraw"]);
  });

  it("removes stale-named files but keeps current hash-named records", async () => {
    const legacyName = `${Buffer.from(longId, "utf8").toString("base64url")}.json`;
    await writeFile(path.join(dir, legacyName), JSON.stringify(record(longId)));
    await writeThumbnailRecord(record(longId), { cacheDir: dir });
    await writeThumbnailRecord(record("fresh.excalidraw"), { cacheDir: dir });

    const result = await pruneThumbnailCache(new Set([longId, "fresh.excalidraw"]), 2000, {
      cacheDir: dir,
    });

    expect(result.removed).toBe(1);
    await expect(stat(path.join(dir, legacyName))).rejects.toThrow();
    const hits = await readThumbnailRecords([longId, "fresh.excalidraw"], { cacheDir: dir });
    expect(hits.map((r) => r.fileId).toSorted()).toEqual([longId, "fresh.excalidraw"]);
  });

  it("evicts oldest records first when over the byte cap", async () => {
    const ids = ["a.excalidraw", "b.excalidraw", "c.excalidraw"];
    for (const [index, id] of ids.entries()) {
      const file = path.join(dir, thumbnailKey(id));
      await writeFile(file, JSON.stringify(record(id)));
      const stamp = 1_000_000 + index * 1_000;
      await utimes(file, stamp / 1000, stamp / 1000);
    }
    const sizes = await Promise.all(
      ids.map((id) => stat(path.join(dir, thumbnailKey(id))).then((s) => s.size)),
    );

    const result = await pruneThumbnailCache(new Set(ids), 2000, {
      cacheDir: dir,
      byteCap: sizes[1] + sizes[2],
    });

    expect(result.removed).toBe(1);
    const survivors = (await readThumbnailRecords(ids, { cacheDir: dir }))
      .map((r) => r.fileId)
      .toSorted();
    expect(survivors).toEqual(["b.excalidraw", "c.excalidraw"]);
  });

  it("evicts oldest records first when over the cap", async () => {
    const ids = ["a.excalidraw", "b.excalidraw", "c.excalidraw"];
    for (const [index, id] of ids.entries()) {
      await writeThumbnailRecord(record(id), { cacheDir: dir });
      const file = path.join(dir, thumbnailKey(id));
      const stamp = 1_000_000 + index * 1_000;
      await utimes(file, stamp / 1000, stamp / 1000);
    }

    await pruneThumbnailCache(new Set(ids), 2, { cacheDir: dir });

    const remainingIds = (await readThumbnailRecords(ids, { cacheDir: dir }))
      .map((r) => r.fileId)
      .toSorted();
    expect(remainingIds).toEqual(["b.excalidraw", "c.excalidraw"]);
  });
});
