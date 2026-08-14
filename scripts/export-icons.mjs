#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = process.argv.slice(2);
const isCheck = cliArgs.includes("--check");
const masterArg = cliArgs.find((a) => !a.startsWith("-"));
const master = path.resolve(root, masterArg || "assets/icon.png");

const resolveMagick = () => {
  for (const cmd of ["magick", "convert"]) {
    try {
      execFileSync(cmd, ["-version"], { stdio: "ignore" });
      return cmd;
    } catch {
      // ImageMagick not found in PATH; try the next candidate.
    }
  }

  return null;
};

const magick = resolveMagick();
if (!magick) {
  console.error("ImageMagick not found (need `magick` or `convert` on PATH).");
  process.exit(1);
}

if (!existsSync(master)) {
  console.error(`Master icon not found: ${master}`);
  process.exit(1);
}

const outputs = {
  ico: path.join(root, "assets", "icon.ico"),
  icns: path.join(root, "assets", "icon.icns"),
};

if (isCheck) {
  const masterMtime = statSync(master).mtimeMs;
  const stale = Object.entries(outputs).filter(
    ([, p]) => !existsSync(p) || statSync(p).mtimeMs < masterMtime,
  );

  if (stale.length) {
    const rel = stale.map(([, p]) => path.relative(root, p)).join(", ");
    console.error(`Icon outputs are missing or stale: ${rel}`);
    console.error(`Run \`vp run icons:export\` to regenerate from ${path.relative(root, master)}.`);
    process.exit(1);
  }

  console.log("Icons up to date.");
  process.exit(0);
}

const buildDir = path.join(root, "assets");
mkdirSync(buildDir, { recursive: true });
const tmp = path.join(buildDir, ".icns-tmp");
mkdirSync(tmp, { recursive: true });

const runMagick = (args) => execFileSync(magick, args, { stdio: "inherit" });

runMagick([master, "-define", "icon:auto-resize=256,128,64,48,32,16", outputs.ico]);

const sizes = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];

const chunks = sizes.map(([type, size]) => {
  const png = path.join(tmp, `${type}.png`);
  runMagick([master, "-resize", `${size}x${size}`, png]);

  const data = readFileSync(png);
  const chunk = Buffer.alloc(8 + data.length);

  chunk.write(type, 0, "ascii");
  chunk.writeUInt32BE(chunk.length, 4);

  data.copy(chunk, 8);
  return chunk;
});

const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
const icns = Buffer.alloc(total);

icns.write("icns", 0, "ascii");
icns.writeUInt32BE(total, 4);

let off = 8;
for (const c of chunks) {
  c.copy(icns, off);
  off += c.length;
}

writeFileSync(outputs.icns, icns);

rmSync(tmp, { recursive: true, force: true });
console.log(`Generated: assets/icon.ico, assets/icon.icns from ${path.relative(root, master)}`);
