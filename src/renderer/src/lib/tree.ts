import type { FileEntry } from "@shared/ipc";
import { parentIdOf } from "@shared/ipc";

export const EXPANDED_FOLDERS_STORAGE_KEY = "xdrawz.expandedFolderIds";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const rankOf = (entry: FileEntry): number => (entry.kind === "directory" ? 0 : 1);

export const sortSiblings = (children: FileEntry[]): FileEntry[] =>
  children.toSorted((a, b) => {
    const rankDelta = rankOf(a) - rankOf(b);
    if (rankDelta !== 0) return rankDelta;
    return collator.compare(a.name, b.name);
  });

export const buildSortedChildIndex = (entries: FileEntry[]): Map<string | null, FileEntry[]> => {
  const index = new Map<string | null, FileEntry[]>();

  for (const entry of entries) {
    const siblings = index.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else index.set(entry.parentId, [entry]);
  }

  for (const [parent, children] of index) {
    index.set(parent, sortSiblings(children));
  }

  return index;
};

export const buildEntriesById = (entries: FileEntry[]): Map<string, FileEntry> => {
  const map = new Map<string, FileEntry>();
  for (const entry of entries) map.set(entry.id, entry);
  return map;
};

export const ancestorIdsOf = (id: string): string[] => {
  const out: string[] = [];
  let current = parentIdOf(id);

  while (current !== null) {
    out.push(current);
    current = parentIdOf(current);
  }

  out.reverse();
  return out;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const parseExpandedFolderIds = (raw: string | null): Set<string> => {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
};

export const readExpandedFolderIds = (storage: StorageReader): Set<string> => {
  try {
    return parseExpandedFolderIds(storage.getItem(EXPANDED_FOLDERS_STORAGE_KEY));
  } catch {
    return new Set();
  }
};

export const writeExpandedFolderIds = (storage: StorageWriter, ids: Iterable<string>): void => {
  try {
    storage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    return;
  }
};
