import { Buffer } from "node:buffer";
import { Dirent, Stats, constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open as fsOpen,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { ErrorCode } from "@shared/errors";
import {
  FILE_NOT_FOUND_MESSAGE,
  parentIdOf,
  type FileDeleteMode,
  type FileEntry,
  sortFileEntries,
} from "@shared/ipc";

import { getDrawings } from "./drawings";

const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

const normalizeId = (id: string) => (isMac ? id.normalize("NFC") : id);
const normalizeFsName = (name: string) => (isMac ? name.normalize("NFC") : name);

export const errorWithCode = (message: string, code: ErrorCode): Error => {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
};

const errorCodeOf = (error: unknown) => {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const contains = (parent: string, child: string) => {
  const p = isWindows ? parent.toLowerCase() : parent;
  const c = isWindows ? child.toLowerCase() : child;
  const rel = path.relative(p, c);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
};

const realpathFromExistingAncestor = async (targetAbs: string) => {
  const missing: string[] = [];
  let current = targetAbs;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.toReversed());
    } catch (error) {
      if (errorCodeOf(error) !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
};

const assertSafeIdString = (id: string) => {
  if (id.includes("\0")) throw errorWithCode("Invalid path", "INVALID");
  if (path.isAbsolute(id)) throw errorWithCode("Absolute paths not allowed", "INVALID");
  if (/^[a-zA-Z]:/.test(id)) throw errorWithCode("Drive letters not allowed", "INVALID");
  if (id.startsWith("\\\\") || id.startsWith("//")) {
    throw errorWithCode("UNC paths not allowed", "INVALID");
  }
  if (id.includes("\\")) throw errorWithCode("Invalid path", "INVALID");
};

const getCanonicalRoot = async () => {
  const rawRoot = await requireDrawingsRoot();
  return realpath(rawRoot);
};

const assertInsideRealRoot = async (rootReal: string, candidateAbs: string) => {
  const candidateReal = await realpathFromExistingAncestor(candidateAbs);
  if (!contains(rootReal, candidateReal)) throw new Error("Path escapes drawings root");
  return candidateReal;
};

const assertParentsNotSymlinks = async (
  rootLex: string,
  rootReal: string,
  candidateAbs: string,
) => {
  const parent = path.dirname(candidateAbs);
  const rel = path.relative(rootLex, parent);
  if (rel === "") return;
  if (path.isAbsolute(rel) || rel.startsWith("..")) return;

  let current = rootLex;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const lst = await lstat(current).catch(() => null);
    if (!lst) continue;
    if (lst.isSymbolicLink()) throw errorWithCode("Symlink in path", "INVALID");
    if (lst.isDirectory()) {
      const realCurrent = await realpath(current).catch(() => null);
      if (realCurrent && !contains(rootReal, realCurrent)) {
        throw new Error("Path escapes drawings root");
      }
    }
  }
};

const assertNotSymlink = async (absPath: string) => {
  let lst: Stats;
  try {
    lst = await lstat(absPath);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return;
    throw error;
  }
  if (lst.isSymbolicLink()) throw errorWithCode("Symlinks not allowed", "INVALID");
  if (lst.isFile() && lst.nlink > 1) throw errorWithCode("Hardlinks not allowed", "INVALID");
};

export type FsMutationHooks = {
  beforeMutate?: (absPaths: string[]) => void;
};

export const atomicWriteFile = async (absPath: string, data: string, hooks?: FsMutationHooks) => {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);

  hooks?.beforeMutate?.([absPath, tmp]);

  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    (isWindows ? 0 : fsConstants.O_NOFOLLOW);

  let fh: Awaited<ReturnType<typeof fsOpen>> | undefined;
  try {
    fh = await fsOpen(tmp, flags, 0o600);
    await fh.writeFile(data, "utf8");
    await fh.close();
    fh = undefined;
  } catch (error) {
    await fh?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }

  try {
    await rename(tmp, absPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
};

const isExcalidrawFileName = (name: string) => name.toLowerCase().endsWith(".excalidraw");

const toRelativeId = (root: string, absPath: string) =>
  path.relative(root, absPath).split(path.sep).filter(Boolean).join("/");

const entryFromAbs = async (
  root: string,
  absPath: string,
  kind: "file" | "directory",
): Promise<FileEntry> => {
  const id = toRelativeId(root, absPath);
  const stats = await lstat(absPath);
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
  const normalizedId = normalizeId(id);
  assertSafeIdString(normalizedId);

  const root = await requireDrawingsRoot();
  const rootReal = await getCanonicalRoot();
  const absPath = path.resolve(root, ...normalizedId.split("/").filter(Boolean));
  if (!contains(path.resolve(root), absPath)) throw new Error("Path escapes drawings root");

  const candidateReal = await assertInsideRealRoot(rootReal, absPath);
  await assertParentsNotSymlinks(root, rootReal, absPath);
  await assertNotSymlink(absPath);

  return { root, rootReal, absPath, candidateReal };
};

const walkEntries = async (root: string): Promise<FileEntry[]> => {
  const out: FileEntry[] = [];
  const rootReal = await getCanonicalRoot();

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

      let lst: Stats;
      try {
        lst = await lstat(absPath);
      } catch {
        continue;
      }

      if (lst.isSymbolicLink()) continue;
      if (lst.isFile() && lst.nlink > 1) continue;

      const id = toRelativeId(root, absPath);

      if (lst.isDirectory()) {
        if (isWindows) {
          const realChild = await realpath(absPath).catch(() => null);
          if (realChild === null || !contains(rootReal, realChild)) continue;
        }

        out.push({
          id,
          name: normalizeFsName(dirent.name),
          kind: "directory",
          parentId: parentIdOf(id),
          modifiedAt: lst.mtimeMs,
          size: 0,
        });

        await walk(absPath);
        continue;
      }

      if (lst.isFile() && isExcalidrawFileName(dirent.name)) {
        out.push({
          id,
          name: normalizeFsName(dirent.name),
          kind: "file",
          parentId: parentIdOf(id),
          modifiedAt: lst.mtimeMs,
          size: lst.size,
        });
      }
    }
  };

  await walk(root);
  return sortFileEntries(out);
};

const requireDrawingsRoot = async () => {
  const info = await getDrawings();
  if (!info.configured || !info.path) throw new Error("Drawings folder not configured");
  return path.resolve(info.path);
};

const EMPTY_DRAWING_CONTENT =
  '{"type":"excalidraw","version":2,"source":"xdrawz","elements":[],"appState":{},"files":{}}';

const assertDrawingJson = (content: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw errorWithCode("Drawing content is not valid JSON", "INVALID");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw errorWithCode("Drawing must be a JSON object", "INVALID");
  }

  const drawing = parsed;
  if ("elements" in drawing && !Array.isArray(drawing.elements)) {
    throw errorWithCode("Drawing elements must be an array when present", "INVALID");
  }

  if (
    "files" in drawing &&
    (drawing.files === null || typeof drawing.files !== "object" || Array.isArray(drawing.files))
  ) {
    throw errorWithCode("Drawing files must be an object when present", "INVALID");
  }
};

const assertContentSize = (content: string) => {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_CONTENT_BYTES) {
    throw errorWithCode(`Content exceeds ${MAX_FILE_CONTENT_BYTES} bytes`, "TOO_LARGE");
  }
};

export const readDrawingFile = async (id: string) => {
  const { candidateReal } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be read");
  }

  const flags = isWindows ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

  let fh: Awaited<ReturnType<typeof fsOpen>>;
  try {
    fh = await fsOpen(candidateReal, flags);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Error("Path escapes drawings root", { cause: error });
    }
    throw error;
  }

  try {
    const stats = await fh.stat();
    if (stats.isDirectory()) throw new Error("Cannot read a directory as a drawing");
    if (stats.isFile() && stats.nlink > 1) {
      throw errorWithCode("Hardlinks not allowed", "INVALID");
    }

    if (stats.size > MAX_FILE_CONTENT_BYTES) {
      throw errorWithCode("File is too large to load", "TOO_LARGE");
    }

    const content = await fh.readFile("utf8");
    assertDrawingJson(content);
    return content;
  } finally {
    await fh.close().catch(() => {});
  }
};

const ensureNotDirectory = async (absPath: string) => {
  const existing = await lstat(absPath).catch(() => null);
  if (existing?.isDirectory()) throw new Error("Cannot write over a directory");
  if (existing?.isSymbolicLink()) throw errorWithCode("Invalid file", "INVALID");
  if (existing?.isFile() && existing.nlink > 1) throw errorWithCode("Invalid file", "INVALID");
};

export const writeDrawingFile = async (
  id: string,
  content: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> => {
  if (typeof content !== "string") throw new Error("Content must be a string");

  assertContentSize(content);
  assertDrawingJson(content);

  const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be written");
  }

  const existing = await lstat(absPath).catch(() => null);
  if (!existing) throw errorWithCode(FILE_NOT_FOUND_MESSAGE, "NOT_FOUND");
  if (existing.isDirectory()) throw new Error("Cannot write over a directory");

  await assertInsideRealRoot(rootReal, absPath);
  await assertParentsNotSymlinks(root, rootReal, absPath);
  await assertNotSymlink(absPath);

  await atomicWriteFile(candidateReal, content.endsWith("\n") ? content : `${content}\n`, hooks);
  return entryFromAbs(root, absPath, "file");
};

export const writeDrawingFileRecover = async (
  id: string,
  content: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> => {
  if (typeof content !== "string") throw new Error("Content must be a string");

  assertContentSize(content);
  assertDrawingJson(content);

  const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

  if (!isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be written");
  }

  await assertParentsNotSymlinks(root, rootReal, absPath);
  await mkdir(path.dirname(candidateReal), { recursive: true });

  await assertInsideRealRoot(rootReal, absPath);
  await assertParentsNotSymlinks(root, rootReal, absPath);
  await ensureNotDirectory(absPath);

  await atomicWriteFile(candidateReal, content.endsWith("\n") ? content : `${content}\n`, hooks);
  return entryFromAbs(root, absPath, "file");
};

export const renameEntry = async (
  id: string,
  newName: string,
  hooks?: FsMutationHooks,
): Promise<FileEntry> => {
  const { root, rootReal, absPath, candidateReal } = await resolveInsideRoot(id);

  const lst = await lstat(absPath);
  if (lst.isSymbolicLink()) throw errorWithCode("Symlinks not allowed", "INVALID");
  if (lst.isFile() && lst.nlink > 1) throw errorWithCode("Hardlinks not allowed", "INVALID");
  const isDirectory = lst.isDirectory();

  if (!isDirectory && !isExcalidrawFileName(path.basename(id))) {
    throw new Error("Only .excalidraw files can be renamed");
  }

  const leaf = newName.trim();
  if (!leaf) throw new Error("Name cannot be empty");
  if (leaf.includes("/") || leaf.includes("\\")) {
    throw new Error("Name cannot contain path separators");
  }

  const nameWithExt = isDirectory || isExcalidrawFileName(leaf) ? leaf : `${leaf}.excalidraw`;
  const nextAbs = path.join(path.dirname(absPath), nameWithExt);

  if (!contains(path.resolve(root), nextAbs)) throw new Error("Path escapes drawings root");

  const nextReal = await assertInsideRealRoot(rootReal, nextAbs);
  await assertParentsNotSymlinks(root, rootReal, nextAbs);

  if (nextAbs === absPath) {
    return entryFromAbs(root, absPath, isDirectory ? "directory" : "file");
  }

  const exists = await lstat(nextAbs).catch(() => null);
  if (exists) throw new Error("A file or folder with that name already exists");

  const kind = isDirectory ? "directory" : "file";

  if (nextAbs.toLowerCase() === absPath.toLowerCase()) {
    const tempAbs = `${candidateReal}.renaming-${process.pid}-${Date.now()}`;
    hooks?.beforeMutate?.([candidateReal, tempAbs, nextReal]);
    await rename(candidateReal, tempAbs);
    try {
      await rename(tempAbs, nextReal);
    } catch (error) {
      await rename(tempAbs, candidateReal).catch(() => {});
      throw error;
    }
    return entryFromAbs(root, nextAbs, kind);
  }

  hooks?.beforeMutate?.([candidateReal, nextReal]);
  await rename(candidateReal, nextReal);

  return entryFromAbs(root, nextAbs, kind);
};

export const createEntry = async (
  parentId: string | null,
  name: string,
  kind: "file" | "directory",
  hooks?: FsMutationHooks,
): Promise<FileEntry> => {
  const leaf = name.trim();
  if (!leaf) throw new Error("Name cannot be empty");
  if (leaf.includes("/") || leaf.includes("\\")) {
    throw new Error("Name cannot contain path separators");
  }

  const root = await requireDrawingsRoot();
  const rootReal = await getCanonicalRoot();

  let parentAbs = root;
  if (parentId !== null) {
    const normalizedParent = normalizeId(parentId);
    assertSafeIdString(normalizedParent);

    parentAbs = path.resolve(root, ...normalizedParent.split("/").filter(Boolean));
    if (!contains(path.resolve(root), parentAbs)) throw new Error("Path escapes drawings root");

    await assertInsideRealRoot(rootReal, parentAbs);
    await assertParentsNotSymlinks(root, rootReal, parentAbs);

    const parentStats = await lstat(parentAbs).catch(() => null);
    if (!parentStats || !parentStats.isDirectory() || parentStats.isSymbolicLink()) {
      throw errorWithCode("Parent folder not found", "NOT_FOUND");
    }
  }

  const nameForFs = kind === "file" && !isExcalidrawFileName(leaf) ? `${leaf}.excalidraw` : leaf;
  const nextAbs = path.join(parentAbs, nameForFs);
  if (!contains(path.resolve(root), nextAbs)) throw new Error("Path escapes drawings root");

  const nextReal = await assertInsideRealRoot(rootReal, nextAbs);
  await assertParentsNotSymlinks(root, rootReal, nextAbs);

  const exists = await lstat(nextAbs).catch(() => null);
  if (exists) throw new Error("A file or folder with that name already exists");

  if (kind === "directory") {
    hooks?.beforeMutate?.([nextReal]);
    await mkdir(nextReal);
  } else {
    await atomicWriteFile(nextReal, `${EMPTY_DRAWING_CONTENT}\n`, hooks);
  }

  return entryFromAbs(root, nextAbs, kind);
};

export const deleteEntry = async (
  id: string,
  mode: FileDeleteMode = "trash",
  hooks?: FsMutationHooks,
  trashItem?: (path: string) => Promise<void>,
) => {
  const { rootReal, candidateReal } = await resolveInsideRoot(id);
  if (candidateReal === rootReal) throw new Error("Cannot delete drawings root");

  hooks?.beforeMutate?.([candidateReal]);

  const lst = await lstat(candidateReal).catch(() => null);
  if (!lst) return;

  if (lst.isSymbolicLink()) {
    await unlink(candidateReal);
    return;
  }

  if (mode === "permanent") {
    await rm(candidateReal, { recursive: true, force: false, maxRetries: 2 });
    return;
  }

  if (!trashItem) throw errorWithCode("Trash is unavailable", "UNKNOWN");
  await trashItem(candidateReal);
};

export const listEntries = async (root?: string): Promise<FileEntry[]> => {
  const info = await getDrawings();
  if (!info.configured || !info.path) return [];

  const configured = path.resolve(info.path);
  const canonicalConfigured = await realpath(configured).catch(() => null);
  if (!canonicalConfigured) return [];

  if (root) {
    const resolved = path.resolve(root);
    const realRequested = await realpath(resolved).catch(() => null);
    const inside =
      realRequested !== null
        ? contains(canonicalConfigured, realRequested)
        : contains(configured, resolved);
    if (!inside) throw new Error("Path escapes drawings root");
  }

  return walkEntries(configured);
};
