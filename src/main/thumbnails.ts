import { Dirent } from "node:fs";
import { readdir, readFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";

import type { ThumbnailRecord } from "@shared/ipc";
import { app } from "electron";

import { atomicWriteFile } from "./files";

export const THUMBNAIL_CACHE_DIR_NAME = "thumbnails";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export type ThumbnailCacheOptions = {
  cacheDir?: string;
};

export const getThumbnailCacheDir = (): string =>
  path.join(app.getPath("userData"), THUMBNAIL_CACHE_DIR_NAME);

const resolveCacheDir = (opts: ThumbnailCacheOptions): string =>
  opts.cacheDir ?? getThumbnailCacheDir();

export const thumbnailKey = (fileId: string): string =>
  `${Buffer.from(fileId, "utf8").toString("base64url")}.json`;

export const decodeThumbnailKey = (fileName: string): string | null => {
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
    typeof record.light === "string" &&
    record.light.startsWith(PNG_DATA_URL_PREFIX) &&
    typeof record.dark === "string" &&
    record.dark.startsWith(PNG_DATA_URL_PREFIX)
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

export const readThumbnailRecords = async (
  ids: string[],
  opts: ThumbnailCacheOptions = {},
): Promise<ThumbnailRecord[]> => {
  if (ids.length === 0) return [];

  const dir = resolveCacheDir(opts);
  const records = await Promise.all(
    ids.map((fileId) =>
      parseRecordFile(path.join(dir, thumbnailKey(fileId))).then((record) =>
        record ? ([fileId, record] as const) : null,
      ),
    ),
  );

  return records.flatMap((item) => (item ? [item[1]] : []));
};

const ensureCacheDir = async (opts: ThumbnailCacheOptions): Promise<string> => {
  const dir = resolveCacheDir(opts);
  await mkdir(dir, { recursive: true });
  return dir;
};

export const writeThumbnailRecord = async (
  record: ThumbnailRecord,
  opts: ThumbnailCacheOptions = {},
): Promise<void> => {
  const dir = await ensureCacheDir(opts);
  await atomicWriteFile(path.join(dir, thumbnailKey(record.fileId)), JSON.stringify(record));
};

export const pruneThumbnailCache = async (
  validIds: Set<string>,
  cap = 2000,
  opts: ThumbnailCacheOptions = {},
): Promise<{ removed: number }> => {
  const dir = resolveCacheDir(opts);

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }

  type KeptRecord = { name: string; mtimeMs: number };
  let removed = 0;
  const removeJobs: Promise<void>[] = [];
  const keptJobs: Promise<KeptRecord | null>[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const filePath = path.join(dir, entry.name);
    const fileId = decodeThumbnailKey(entry.name);

    if (fileId === null || !validIds.has(fileId)) {
      removed += 1;
      removeJobs.push(rm(filePath, { force: true }).catch(() => {}));
      continue;
    }

    keptJobs.push(
      stat(filePath).then(
        (stats) => ({ name: entry.name, mtimeMs: stats.mtimeMs }),
        () => {
          removed += 1;
          return null;
        },
      ),
    );
  }

  await Promise.all(removeJobs);
  const settled = await Promise.all(keptJobs);
  const kept = settled.filter((item): item is KeptRecord => item !== null);

  if (kept.length > cap) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = kept.slice(0, kept.length - cap);
    await Promise.all(
      excess.map((item) => rm(path.join(dir, item.name), { force: true }).catch(() => {})),
    );
    removed += excess.length;
  }

  return { removed };
};
