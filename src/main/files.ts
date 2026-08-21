import { Buffer } from "node:buffer";
import { Dirent, Stats } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { errorWithCode } from "@shared/errors";
import { FILE_NOT_FOUND_MESSAGE, MAX_FILE_CONTENT_BYTES, type FileEntry } from "@shared/ipc";

import { assertDrawingJson } from "./drawing-json";
import { getDrawings } from "./drawings";

export type FsMutationHooks = {
  beforeMutate?: (absPaths: string[]) => void;
};

const isExcalidrawFileName = (name: string) => name.toLowerCase().endsWith(".excalidraw");

const parentIdOf = (id: string) => {
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

  const walk = async (dirAbs: string) => {
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
  return out.toSorted((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
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

const assertContentSize = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_CONTENT_BYTES) {
    throw errorWithCode(`Content exceeds ${MAX_FILE_CONTENT_BYTES} bytes`, "TOO_LARGE");
  }
};

const atomicWriteFile = async (absPath: string, data: string, hooks?: FsMutationHooks) => {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);

  hooks?.beforeMutate?.([absPath, tmp]);

  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, absPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});

    throw error;
  }
};

export const readDrawingFile = async (id: string) => {
  const { absPath } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be read");
  }

  const stats = await stat(absPath);
  if (stats.isDirectory()) throw new Error("Cannot read a directory as a drawing");
  if (stats.size > MAX_FILE_CONTENT_BYTES)
    throw errorWithCode("File is too large to load", "TOO_LARGE");

  const content = await readFile(absPath, "utf8");
  assertDrawingJson(content);
  return content;
};

const ensureNotDirectory = async (absPath: string) => {
  const existing = await stat(absPath).catch(() => null);
  if (existing?.isDirectory()) throw new Error("Cannot write over a directory");
};

export const writeDrawingFile = async (id: string, content: string, hooks?: FsMutationHooks) => {
  if (typeof content !== "string") throw new Error("Content must be a string");

  assertContentSize(content);
  assertDrawingJson(content);

  const { absPath } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be written");
  }

  const existing = await stat(absPath).catch(() => null);
  if (!existing) throw errorWithCode(FILE_NOT_FOUND_MESSAGE, "NOT_FOUND");
  if (existing.isDirectory()) throw new Error("Cannot write over a directory");

  await atomicWriteFile(absPath, content.endsWith("\n") ? content : `${content}\n`, hooks);
};

export const writeDrawingFileRecover = async (
  id: string,
  content: string,
  hooks?: FsMutationHooks,
) => {
  if (typeof content !== "string") throw new Error("Content must be a string");

  assertContentSize(content);
  assertDrawingJson(content);

  const { absPath } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be written");
  }

  await mkdir(path.dirname(absPath), { recursive: true });
  await ensureNotDirectory(absPath);
  await atomicWriteFile(absPath, content.endsWith("\n") ? content : `${content}\n`, hooks);
};

export const renameEntry = async (
  id: string,
  newName: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> => {
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

  hooks?.beforeMutate?.([absPath, nextAbs]);
  await rename(absPath, nextAbs);
  return entryFromAbs(root, nextAbs, "file");
};

export const deleteEntry = async (id: string, hooks?: FsMutationHooks) => {
  const { root, absPath } = await resolveInsideRoot(id);

  if (absPath === root) throw new Error("Cannot delete drawings root");

  const stats = await stat(absPath);
  if (stats.isDirectory()) throw new Error("Only files can be deleted");

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be deleted");
  }

  hooks?.beforeMutate?.([absPath]);
  await rm(absPath, { force: false });
};

export const listEntries = async (root?: string): Promise<FileEntry[]> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) return [];

  const configured = path.resolve(info.path);
  if (root) {
    const resolved = path.resolve(root);
    if (resolved !== configured) {
      throw new Error("Path escapes drawings root");
    }

    return walkEntries(resolved);
  }

  return walkEntries(configured);
};
