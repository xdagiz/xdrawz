import type { FileEntry } from "@shared/ipc";

export const RECENT_FILE_IDS_LIMIT = 10;

export const pushRecentId = (ids: string[], id: string): string[] =>
  [id, ...ids.filter((existing) => existing !== id)].slice(0, RECENT_FILE_IDS_LIMIT);

export const removeRecentIds = (ids: string[], predicate: (id: string) => boolean): string[] =>
  ids.filter((id) => !predicate(id));

export const remapRecentIds = (ids: string[], remap: (id: string) => string): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    const mapped = remap(id);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
};

export const selectRecentFiles = (ids: string[], entries: FileEntry[]): FileEntry[] => {
  const fileById = new Map(
    entries.filter((entry) => entry.kind === "file").map((entry) => [entry.id, entry]),
  );

  const selected: FileEntry[] = [];
  for (const id of ids) {
    if (selected.length >= RECENT_FILE_IDS_LIMIT) break;
    const entry = fileById.get(id);
    if (entry) selected.push(entry);
  }
  return selected;
};

export const parseRecentIdsJson = (json: string | null): string[] => {
  if (!json) return [];

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return [];
    ids.push(item);
  }
  return ids;
};
