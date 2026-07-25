import { stat as fsStat } from "node:fs/promises";
import path from "node:path";

import type { DrawingInfo, FileEntry } from "@shared/ipc";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";

export type FilesChangedPayload = {
  entries: FileEntry[];
  revision: number;
  root: string | null;
  info?: DrawingInfo;
};

export type WatcherCallbacks = {
  onChange: (payload: FilesChangedPayload) => void;
  onRootInvalid?: (reason: "missing" | "not-directory", revision: number) => void;
  onError?: (error: unknown) => void;
};

export type WatcherDeps = {
  listEntries: (root: string) => Promise<FileEntry[]>;
  getDrawings: () => Promise<DrawingInfo>;
  watch?: typeof chokidarWatch;
  statFn?: (path: string) => Promise<{ isDirectory: () => boolean }>;
  now?: () => number;
  coalesceMs?: number;
  defaultIgnoreTtlMs?: number;
};

export type DrawingsWatcher = {
  start: (root: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: (root: string | null) => Promise<void>;
  isWatching: () => boolean;
  getRoot: () => string | null;
  getRevision: () => number;
  ignorePath: (absPath: string, ttlMs?: number) => void;
  ignorePaths: (absPaths: string[], ttlMs?: number) => void;
  refreshNow: () => Promise<void>;
};

const DEFAULT_COALESCE_MS = 200;
const DEFAULT_IGNORE_TTL_MS = 1500;
const DOT_FILE_RE = /(^|[/\\])\.[^/\\]/;
const EXCALIDRAW_EXT = ".excalidraw";
const DIR_EVENTS = new Set(["addDir", "unlinkDir"]);

const isExcalidrawFile = (name: string): boolean => name.toLowerCase().endsWith(EXCALIDRAW_EXT);
const normalizePath = (p: string): string => path.resolve(p);
const eventAbsPath = (eventPath: string): string => path.resolve(eventPath);

export const createDrawingsWatcher = (
  callbacks: WatcherCallbacks,
  deps: WatcherDeps,
): DrawingsWatcher => {
  const {
    listEntries,
    getDrawings,
    watch = chokidarWatch,
    statFn = fsStat,
    now = Date.now,
    coalesceMs = DEFAULT_COALESCE_MS,
    defaultIgnoreTtlMs = DEFAULT_IGNORE_TTL_MS,
  } = deps;

  let currentRoot: string | null = null;
  let revision = 0;
  let chokidarInstance: FSWatcher | null = null;

  const ignored = new Map<string, number>();

  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceArmed = false;

  let listing = false;
  let pending = false;
  let stopped = false;

  const isIgnored = (absPath: string) => {
    const exp = ignored.get(absPath);
    if (exp == null) return false;
    if (now() > exp) {
      ignored.delete(absPath);
      return false;
    }
    return true;
  };

  const ignorePath = (absPath: string, ttlMs = defaultIgnoreTtlMs) => {
    ignored.set(normalizePath(absPath), now() + ttlMs);
  };

  const ignorePaths = (absPaths: string[], ttlMs = defaultIgnoreTtlMs) => {
    const deadline = now() + ttlMs;
    for (const p of absPaths) {
      ignored.set(normalizePath(p), deadline);
    }
  };

  const shouldDrop = (event: string, rawPath: string) => {
    const absPath = eventAbsPath(rawPath);
    if (isIgnored(absPath)) return true;
    if (DOT_FILE_RE.test(absPath)) return true;

    if (DIR_EVENTS.has(event)) return false;

    const basename = path.basename(absPath);
    if (isExcalidrawFile(basename)) return false;

    return true;
  };

  const armCoalesce = () => {
    if (coalesceArmed) return;
    coalesceArmed = true;

    coalesceTimer = setTimeout(() => {
      coalesceArmed = false;
      coalesceTimer = null;
      void refresh();
    }, coalesceMs);
  };

  const clearCoalesce = () => {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    coalesceArmed = false;
  };

  const refresh = async () => {
    if (listing) {
      pending = true;
      return;
    }

    listing = true;
    try {
      do {
        pending = false;
        if (stopped || !currentRoot) return;

        let entries: FileEntry[];
        try {
          entries = await listEntries(currentRoot);
        } catch {
          return;
        }

        if (stopped || !currentRoot) return;
        const info = await getDrawings().catch(() => undefined);
        if (stopped || !currentRoot) return;

        revision += 1;
        callbacks.onChange({
          entries,
          revision,
          root: currentRoot,
          info,
        });
      } while (pending);
    } finally {
      listing = false;
    }
  };

  const handleChokidarEvent = (event: string, rawPath: string) => {
    if (stopped) return;
    if (shouldDrop(event, rawPath)) return;
    armCoalesce();
  };

  const handleChokidarError = async (error: unknown) => {
    callbacks.onError?.(error);
    if (!currentRoot) return;

    try {
      const stats = await statFn(currentRoot);
      if (!stats.isDirectory()) await stopInternal("not-directory");
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") await stopInternal("missing");
    }
  };

  const stopInternal = async (reason?: "missing" | "not-directory") => {
    stopped = true;
    clearCoalesce();
    ignored.clear();

    if (chokidarInstance) {
      try {
        await chokidarInstance.close();
      } catch {
        // Ignore close errors.
      }
      chokidarInstance = null;
    }

    currentRoot = null;
    if (reason) {
      revision += 1;
      callbacks.onRootInvalid?.(reason, revision);
    }
  };

  const start = async (root: string) => {
    const resolvedRoot = normalizePath(root);

    if (chokidarInstance && currentRoot === resolvedRoot) return;
    if (chokidarInstance) await stopInternal();

    stopped = false;
    currentRoot = resolvedRoot;

    chokidarInstance = watch(resolvedRoot, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
      ignored: (testPath: string) => DOT_FILE_RE.test(testPath),
      ignorePermissionErrors: true,
      atomic: true,
    });

    chokidarInstance.on("all", handleChokidarEvent);
    chokidarInstance.on("error", handleChokidarError);
  };

  const stop = async () => await stopInternal();

  const restart = async (root: string | null): Promise<void> => {
    await stopInternal();
    if (root) await start(root);
  };

  const isWatching = (): boolean => chokidarInstance !== null && !stopped;
  const getRoot = (): string | null => currentRoot;
  const getRevision = (): number => revision;

  const refreshNow = async () => {
    clearCoalesce();
    await refresh();
  };

  return {
    start,
    stop,
    restart,
    isWatching,
    getRoot,
    getRevision,
    ignorePath,
    ignorePaths,
    refreshNow,
  };
};
