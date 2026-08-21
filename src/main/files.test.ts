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

import { listEntries, readSceneFile, writeSceneFile, writeSceneFileRecover } from "./files";

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
    await expect(readSceneFile("../secret.excalidraw")).rejects.toThrow(
      "Path escapes drawings root",
    );
    await expect(writeSceneFile("..%2fsecret.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("treats ids as literal file names", async () => {
    await writeFile(path.join(ctx.root, "100%.excalidraw"), SCENE);
    await expect(readSceneFile("100%.excalidraw")).resolves.toBe(SCENE);

    await writeFile(path.join(ctx.root, "a%20b.excalidraw"), SCENE);
    await expect(readSceneFile("a%20b.excalidraw")).resolves.toBe(SCENE);
    await expect(readSceneFile("a b.excalidraw")).rejects.toThrow();

    await writeSceneFile("100%.excalidraw", SCENE);
    await expect(readSceneFile("100%.excalidraw")).resolves.toBe(SCENE);
  });

  it("reads and writes existing scene files", async () => {
    await writeFile(path.join(ctx.root, "a.excalidraw"), SCENE);
    await expect(readSceneFile("a.excalidraw")).resolves.toBe(SCENE);

    await writeSceneFile("a.excalidraw", '{"elements":[{"id":"x"}],"files":{}}');
    const onDisk = await readFile(path.join(ctx.root, "a.excalidraw"), "utf8");
    expect(onDisk).toContain('"id":"x"');
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  it("refuses to write a scene that does not exist", async () => {
    await expect(writeSceneFile("missing.excalidraw", SCENE)).rejects.toThrow(
      FILE_NOT_FOUND_MESSAGE,
    );
  });

  it("recover creates missing scene files, including nested directories", async () => {
    await writeSceneFileRecover("folder/new.excalidraw", SCENE);
    await expect(readSceneFile("folder/new.excalidraw")).resolves.toBe(SCENE);
  });

  it("rejects non-excalidraw files and invalid scene JSON", async () => {
    await writeFile(path.join(ctx.root, "notes.txt"), "hi");
    await expect(readSceneFile("notes.txt")).rejects.toThrow("Only .excalidraw files can be read");
    await expect(writeSceneFile("notes.txt", SCENE)).rejects.toThrow(
      "Only .excalidraw files can be written",
    );

    await writeFile(path.join(ctx.root, "bad.excalidraw"), "{nope");
    await expect(readSceneFile("bad.excalidraw")).rejects.toThrow(
      "Scene content is not valid JSON",
    );
  });
});
