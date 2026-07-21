import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileEntry } from "@shared/ipc";

import { getDrawings } from "./drawings";

const isExcalidrawFileName = (name: string) => name.toLowerCase().endsWith(".excalidraw");

const parentIdOf = (id: string): string | null => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
};

const toRelativeId = (root: string, absPath: string): string =>
  path.relative(root, absPath).split(path.sep).filter(Boolean).join("/");

const walkEntries = async (root: string): Promise<FileEntry[]> => {
  const out: FileEntry[] = [];

  const walk = async (dirAbs: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) {
        continue;
      }

      const absPath = path.join(dirAbs, dirent.name);

      let stats;
      try {
        stats = await stat(absPath);
      } catch {
        continue;
      }

      const id = toRelativeId(root, absPath);

      if (stats.isDirectory()) {
        out.push({
          id,
          name: dirent.name,
          kind: "directory",
          parentId: parentIdOf(id),
          modifiedAt: stats.mtimeMs,
          size: 0,
        });
        await walk(absPath);
        continue;
      }

      if (stats.isFile() && isExcalidrawFileName(dirent.name)) {
        out.push({
          id,
          name: dirent.name,
          kind: "file",
          parentId: parentIdOf(id),
          modifiedAt: stats.mtimeMs,
          size: stats.size,
        });
      }
    }
  };

  await walk(root);
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
};

export const listEntries = async (): Promise<FileEntry[]> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) {
    return [];
  }

  return walkEntries(info.path);
};
