import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FILE_NOT_FOUND_MESSAGE } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ctx = vi.hoisted(() => ({
  root: "",
  configured: true,
}));

vi.mock("./drawings", () => ({
  getDrawings: async () => ({
    path: ctx.root || null,
    displayName: "drawings",
    configured: ctx.configured && Boolean(ctx.root),
    missing: false,
  }),
}));

import {
  deleteEntry,
  listEntries,
  readDrawingFile,
  renameEntry,
  writeDrawingFile,
  writeDrawingFileRecover,
} from "./files";

const SCENE = '{"elements":[],"files":{}}\n';

describe("files", () => {
  beforeEach(async () => {
    ctx.configured = true;
    ctx.root = await mkdtemp(path.join(tmpdir(), "xdrawz-files-"));
  });

  afterEach(async () => {
    if (ctx.root) await rm(ctx.root, { recursive: true, force: true });
    ctx.root = "";
  });

  it("lists .excalidraw files and directories, skipping dotfiles", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await mkdir(path.join(ctx.root, "nested"));
    await writeFile(path.join(ctx.root, "nested", "b.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "readme.txt"), "nope");
    await writeFile(path.join(ctx.root, ".hidden.excalidraw"), SCENE);

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["a.excalidraw", "nested", "nested/b.excalidraw"]);
  });

  it("rejects paths that escape the drawings root", async () => {
    await expect(readDrawingFile("../secret.excalidraw")).rejects.toThrow(
      "Path escapes drawings root",
    );
    await expect(writeDrawingFile("..%2fsecret.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("treats ids as literal file names", async () => {
    await writeFile(path.join(ctx.root, "100%.excalidraw"), SCENE);
    await expect(readDrawingFile("100%.excalidraw")).resolves.toBe(SCENE);

    await writeFile(path.join(ctx.root, "a%20b.excalidraw"), SCENE);
    await expect(readDrawingFile("a%20b.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("a b.excalidraw")).rejects.toThrow();

    await writeDrawingFile("100%.excalidraw", SCENE);
    await expect(readDrawingFile("100%.excalidraw")).resolves.toBe(SCENE);
  });

  it("reads and writes existing drawing files", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await expect(readDrawingFile("a.excalidraw")).resolves.toBe(SCENE);

    await writeDrawingFile("a.excalidraw", '{"elements":[{"id":"x"}],"files":{}}');
    const onDisk = await readFile(path.join(ctx.root, "a.excalidraw"), "utf8");
    expect(onDisk).toContain('"id":"x"');
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("refuses to write a drawing that does not exist", async () => {
    await expect(writeDrawingFile("missing.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("recover creates missing drawing files, including nested directories", async () => {
    await writeDrawingFileRecover("folder/new.excalidraw", SCENE);
    await expect(readDrawingFile("folder/new.excalidraw")).resolves.toBe(SCENE);
  });

  it("rejects non-excalidraw files and invalid drawing JSON", async () => {
    await writeFile(path.join(ctx.root, "notes.txt"), "hi");
    await expect(readDrawingFile("notes.txt")).rejects.toThrow(
      "Only .excalidraw files can be read",
    );
    await expect(writeDrawingFile("notes.txt", SCENE)).rejects.toThrow(
      "Only .excalidraw files can be written",
    );

    await writeFile(path.join(ctx.root, "bad.excalidraw"), "{nope");
    await expect(readDrawingFile("bad.excalidraw")).rejects.toThrow(
      "Drawing content is not valid JSON",
    );
  });

  it("renames within the same folder and appends the extension", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await writeFile(path.join(ctx.root, "folder", "a.excalidraw"), SCENE);

    const entry = await renameEntry("folder/a.excalidraw", "b");

    expect(entry.id).toBe("folder/b.excalidraw");
    await expect(readDrawingFile("folder/b.excalidraw")).resolves.toBe(SCENE);
    await expect(readDrawingFile("folder/a.excalidraw")).rejects.toThrow();

    const same = await renameEntry("folder/b.excalidraw", "b.excalidraw");
    expect(same.id).toBe("folder/b.excalidraw");
  });

  it("renames directories without extension coercion and still rejects collisions", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await mkdir(path.join(ctx.root, "other"));
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "b.excalidraw"), SCENE);

    const entry = await renameEntry("folder", "renamed");
    expect(entry.id).toBe("renamed");
    expect(entry.kind).toBe("directory");
    await expect(renameEntry("a.excalidraw", "b")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(renameEntry("renamed", "other")).rejects.toThrow(
      "A file or folder with that name already exists",
    );
    await expect(renameEntry("a.excalidraw", "../escape")).rejects.toThrow(
      "Name cannot contain path separators",
    );

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["a.excalidraw", "b.excalidraw", "other", "renamed"]);
  });

  it("performs case-only renames via a two-step move", async () => {
    await mkdir(path.join(ctx.root, "MixedCase"));

    const entry = await renameEntry("MixedCase", "mixedcase");

    expect(entry.id).toBe("mixedcase");
    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual(["mixedcase"]);
  });

  it("trashes files and folders through the injected trash target", async () => {
    await mkdir(path.join(ctx.root, "folder"));
    await writeFile(path.join(ctx.root, "folder", "nested.excalidraw"), SCENE);
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);

    const trashed: string[] = [];
    const trashItem = async (trashPath: string) => {
      trashed.push(trashPath);
      await rm(trashPath, { recursive: true });
    };

    await deleteEntry("a.excalidraw", "trash", undefined, trashItem);
    await deleteEntry("folder", "trash", undefined, trashItem);

    expect(trashed).toEqual([path.join(ctx.root, "a.excalidraw"), path.join(ctx.root, "folder")]);
    await expect(readDrawingFile("a.excalidraw")).rejects.toThrow();
    await expect(deleteEntry(".")).rejects.toThrow("Cannot delete drawings root");
  });

  it("permanently deletes directories recursively when asked", async () => {
    await mkdir(path.join(ctx.root, "gone", "inner"), { recursive: true });
    await writeFile(path.join(ctx.root, "gone", "inner", "a.excalidraw"), SCENE);

    await deleteEntry("gone", "permanent");

    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual([]);
  });

  it("fails trash mode when no trash target is available", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);

    await expect(deleteEntry("a.excalidraw", "trash")).rejects.toThrow("Trash is unavailable");
  });
});
