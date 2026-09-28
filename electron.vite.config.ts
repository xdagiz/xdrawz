import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const excalidrawFontsDir = join(
  dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
  "fonts",
);

const collectFontFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dir, entry.name);
    return entry.isDirectory() ? collectFontFiles(filePath) : [filePath];
  });

const serveFontFile = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const filePath = resolve(excalidrawFontsDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(excalidrawFontsDir + sep)) {
    next();
    return;
  }

  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    next();
    return;
  }

  res.setHeader(
    "Content-Type",
    extname(filePath) === ".woff2" ? "font/woff2" : "application/octet-stream",
  );
  res.setHeader("Content-Length", String(stats.size));

  createReadStream(filePath).pipe(res);
};

const excalidrawFonts = (): Plugin => ({
  name: "xcalidraw-excalidraw-fonts",
  generateBundle() {
    for (const filePath of collectFontFiles(excalidrawFontsDir)) {
      const fileName = relative(excalidrawFontsDir, filePath).split(sep).join("/");
      this.emitFile({
        type: "asset",
        fileName: `fonts/${fileName}`,
        source: readFileSync(filePath),
      });
    }
  },
  configureServer(server) {
    server.middlewares.use("/fonts", serveFontFile);
  },
});

export default defineConfig({
  main: {
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        output: {
          // CJS preload must use .cjs when package.json has "type": "module",
          // otherwise Electron/Node treats index.js as ESM and contextBridge never runs.
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          greeting: resolve(__dirname, "src/renderer/greeting.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss(), excalidrawFonts()],
  },
});
