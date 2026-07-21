import { Dirent, Stats } from "node:fs";
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { FileEntry } from "@shared/ipc";

import { getDrawings } from "./drawings";

const isExcalidrawFileName = (name: string) => name.toLowerCase().endsWith(".excalidraw");

const parentIdOf = (id: string): string | null => {
  const idx = id.lastIndexOf("/");
  return idx === -1 ? null : id.slice(0, idx);
};

const toRelativeId = (root: string, absPath: string) =>
  path.relative(root, absPath).split(path.sep).filter(Boolean).join("/");

const entryFromAbs = async (
  root: string,
  absPath: string,
  kind: "file" | "directory",
): Promise<FileEntry> => {
  const id = toRelativeId(root, absPath);
  const stats = await stat(absPath);
  return {
    id,
    name: path.basename(absPath),
    kind,
    parentId: parentIdOf(id),
    modifiedAt: stats.mtimeMs,
    size: kind === "file" ? stats.size : 0,
  };
};

const resolveInsideRoot = async (id: string) => {
  const root = await requireDrawingsRoot();
  const absPath = path.resolve(root, ...id.split("/"));
  assertInsideRoot(root, absPath);
  return { root, absPath };
};

const walkEntries = async (root: string): Promise<FileEntry[]> => {
  const out: FileEntry[] = [];

  const walk = async (dirAbs: string): Promise<void> => {
    let dirents: Dirent[];
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

      let stats: Stats;
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

const assertInsideRoot = (root: string, candidate: string) => {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(rootWithSep)) {
    throw new Error("Path escapes drawings root");
  }
};

const requireDrawingsRoot = async (): Promise<string> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) throw new Error("Drawings folder not configured");
  return path.resolve(info.path);
};

export const readSceneFile = async (id: string) => {
  const { absPath } = await resolveInsideRoot(id);

  const content = await readFile(absPath, "utf8");
  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be read");
  }

  return content;
};

export const renameEntry = async (id: string, newName: string): Promise<FileEntry> => {
  const { root, absPath } = await resolveInsideRoot(id);

  const stats = await stat(absPath);
  if (stats.isDirectory()) throw new Error("Only files can be renamed");

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be renamed");
  }

  const leaf = newName.trim();
  if (!leaf) throw new Error("Name cannot be empty");
  if (leaf.includes("/") || leaf.includes("\\")) {
    throw new Error("Name cannot contain path separators");
  }

  const nameWithExt = isExcalidrawFileName(leaf) ? leaf : `${leaf}.excalidraw`;
  const nextAbs = path.join(path.dirname(absPath), nameWithExt);

  assertInsideRoot(root, nextAbs);

  if (nextAbs === absPath) {
    return entryFromAbs(root, absPath, "file");
  }

  const exists = await stat(nextAbs).catch(() => null);
  if (exists) throw new Error("A file with that name already exists");

  await rename(absPath, nextAbs);
  return entryFromAbs(root, nextAbs, "file");
};

export const deleteEntry = async (id: string) => {
  const { root, absPath } = await resolveInsideRoot(id);

  if (absPath === root) throw new Error("Cannot delete drawings root");

  const stats = await stat(absPath);
  if (stats.isDirectory()) throw new Error("Only files can be deleted");

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be deleted");
  }

  await rm(absPath, { force: false });
};

export const listEntries = async (): Promise<FileEntry[]> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) return [];
  return walkEntries(path.resolve(info.path));
};
