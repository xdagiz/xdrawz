import { createHash } from "node:crypto";
import { Dirent } from "node:fs";
import { readdir, readFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";

import type { ThumbnailRecord } from "@shared/ipc";
import { app } from "electron";

import { atomicWriteFile } from "./files";

export const THUMBNAIL_CACHE_DIR_NAME = "thumbnails";
export const MAX_THUMBNAIL_DATA_URL_CHARS = 512 * 1024;
export const MAX_THUMBNAIL_CACHE_BYTES = 200 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

const isValidThumbnailDataUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(PNG_DATA_URL_PREFIX) &&
  value.length <= MAX_THUMBNAIL_DATA_URL_CHARS;

export type ThumbnailCacheOptions = {
  cacheDir?: string;
  byteCap?: number;
};

export const getThumbnailCacheDir = () => {
  return path.join(app.getPath("userData"), THUMBNAIL_CACHE_DIR_NAME);
};

const resolveCacheDir = (opts: ThumbnailCacheOptions) => {
  return opts.cacheDir ?? getThumbnailCacheDir();
};

export const thumbnailKey = (fileId: string) => {
  const b64 = Buffer.from(fileId, "utf8").toString("base64url");
  if (b64.length > 200) {
    return `${createHash("sha256").update(fileId).digest("hex")}.json`;
  }
  return `${b64}.json`;
};

export const decodeThumbnailKey = (fileName: string) => {
  if (!fileName.endsWith(".json")) return null;

  const body = fileName.slice(0, -".json".length);
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    if (decoded.length === 0) return null;
    if (Buffer.from(decoded, "utf8").toString("base64url") !== body) return null;
    return decoded;
  } catch {
    return null;
  }
};

export const isValidThumbnailRecord = (value: unknown): value is ThumbnailRecord => {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Partial<ThumbnailRecord>;
  return (
    typeof record.fileId === "string" &&
    record.fileId.length > 0 &&
    typeof record.mtimeMs === "number" &&
    Number.isFinite(record.mtimeMs) &&
    typeof record.size === "number" &&
    Number.isFinite(record.size) &&
    isValidThumbnailDataUrl(record.light) &&
    isValidThumbnailDataUrl(record.dark)
  );
};

const parseRecordFile = async (filePath: string): Promise<ThumbnailRecord | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValidThumbnailRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const READ_BATCH_SIZE = 50;

export const readThumbnailRecords = async (
  ids: string[],
  opts: ThumbnailCacheOptions = {},
): Promise<ThumbnailRecord[]> => {
  if (ids.length === 0) return [];

  const dir = resolveCacheDir(opts);

  const out: ThumbnailRecord[] = [];
  for (let i = 0; i < ids.length; i += READ_BATCH_SIZE) {
    const batch = ids.slice(i, i + READ_BATCH_SIZE);
    const records = await Promise.all(
      batch.map((fileId) => parseRecordFile(path.join(dir, thumbnailKey(fileId)))),
    );
    for (const record of records) if (record) out.push(record);
  }

  return out;
};

const ensureCacheDir = async (opts: ThumbnailCacheOptions) => {
  const dir = resolveCacheDir(opts);
  await mkdir(dir, { recursive: true });
  return dir;
};

export const writeThumbnailRecord = async (
  record: ThumbnailRecord,
  opts: ThumbnailCacheOptions = {},
) => {
  const dir = await ensureCacheDir(opts);
  await atomicWriteFile(path.join(dir, thumbnailKey(record.fileId)), JSON.stringify(record));
};

type KeptRecord = {
  name: string;
  mtimeMs: number;
  size: number;
};

const removeRecordFiles = async (dir: string, names: string[]) => {
  await Promise.all(names.map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})));
};

const evictOverCap = async (dir: string, kept: KeptRecord[], cap: number, byteCap: number) => {
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = kept.reduce((sum, item) => sum + item.size, 0);
  const evicted: KeptRecord[] = [];
  for (const item of kept) {
    if (kept.length - evicted.length <= cap && totalBytes <= byteCap) break;
    evicted.push(item);
    totalBytes -= item.size;
  }

  if (evicted.length > 0) {
    await removeRecordFiles(
      dir,
      evicted.map((item) => item.name),
    );
    kept.splice(0, evicted.length);
  }

  return evicted.length;
};

export const pruneThumbnailCache = async (
  validIds: Set<string>,
  cap = 2000,
  opts: ThumbnailCacheOptions = {},
) => {
  const dir = resolveCacheDir(opts);
  const byteCap = opts.byteCap ?? MAX_THUMBNAIL_CACHE_BYTES;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  let removed = 0;
  const staleNames: string[] = [];
  const undecodable: { name: string; filePath: string }[] = [];
  const keptJobs: Promise<KeptRecord | null>[] = [];

  const keepOrStale = (name: string, fileId: string | null) => {
    if (fileId === null || !validIds.has(fileId) || name !== thumbnailKey(fileId)) {
      removed += 1;
      staleNames.push(name);
      return;
    }

    keptJobs.push(
      stat(path.join(dir, name)).then(
        (stats) => ({ name, mtimeMs: stats.mtimeMs, size: stats.size }),
        () => {
          removed += 1;
          return null;
        },
      ),
    );
  };

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fileId = decodeThumbnailKey(entry.name);
    if (fileId === null) {
      undecodable.push({ name: entry.name, filePath: path.join(dir, entry.name) });
    } else {
      keepOrStale(entry.name, fileId);
    }
  }

  const parsed = await Promise.all(
    undecodable.map(async (item) => ({
      name: item.name,
      fileId: (await parseRecordFile(item.filePath))?.fileId ?? null,
    })),
  );

  for (const item of parsed) keepOrStale(item.name, item.fileId);

  await removeRecordFiles(dir, staleNames);
  const settled = await Promise.all(keptJobs);
  const kept = settled.filter((item): item is KeptRecord => item !== null);
  removed += await evictOverCap(dir, kept, cap, byteCap);

  return { removed };
};
