import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileEntry, ThumbnailRecord } from "@shared/ipc";

import type { ResolvedTheme } from "@/lib/theme";

export type ThumbnailPair = { light: string; dark: string };

export type CacheEntry = ThumbnailRecord & { fetchedAt: number };

export type GenerateThumbnails = (fileId: string) => Promise<ThumbnailPair>;

export type ThumbnailStoreDeps = {
  apiFetch: (ids: string[]) => Promise<ThumbnailRecord[]>;
  apiPut: (record: ThumbnailRecord) => Promise<void>;
  generate: GenerateThumbnails;
};

export type ThumbnailStore = {
  getRecord: (fileId: string) => CacheEntry | undefined;
  isPending: (fileId: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  hydrate: (entries: FileEntry[]) => Promise<void>;
  syncWithEntries: (entries: FileEntry[]) => void;
  cancelPending: () => void;
};

export const THUMBNAIL_MAX_SIZE = 200;

export const THUMBNAIL_CANVAS_BG = {
  light: "#ffffff",
  dark: "#121212",
};

const covers = (record: CacheEntry | undefined, entry: FileEntry): boolean =>
  record !== undefined && record.mtimeMs === entry.modifiedAt && record.size === entry.size;

export const pickThumbnailVariant = (
  record: Pick<ThumbnailRecord, "light" | "dark">,
  resolvedTheme: ResolvedTheme,
): string => (resolvedTheme === "dark" ? record.dark : record.light);

export const createThumbnailStore = (deps: ThumbnailStoreDeps): ThumbnailStore => {
  const records = new Map<string, CacheEntry>();
  const listeners = new Set<() => void>();
  const queue = new Map<string, FileEntry>();
  const inFlight = new Set<string>();
  let epoch = 0;
  let running = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const pump = async (): Promise<void> => {
    if (running) return;

    running = true;
    const myEpoch = epoch;

    try {
      while (queue.size > 0) {
        if (myEpoch !== epoch) return;

        const next = queue.values().next();
        if (next.done) return;
        const entry = next.value;
        queue.delete(entry.id);
        inFlight.add(entry.id);

        try {
          const pair = await deps.generate(entry.id);
          if (myEpoch !== epoch) return;

          const stored: ThumbnailRecord = {
            fileId: entry.id,
            mtimeMs: entry.modifiedAt,
            size: entry.size,
            light: pair.light,
            dark: pair.dark,
          };
          records.set(entry.id, { ...stored, fetchedAt: Date.now() });
          await deps.apiPut(stored);
          notify();
        } catch (error) {
          console.error(`thumbnail generation failed for ${entry.id}`, error);
        } finally {
          inFlight.delete(entry.id);
        }
      }
    } finally {
      running = false;
      if (queue.size > 0) void pump();
    }
  };

  return {
    getRecord: (fileId) => records.get(fileId),

    isPending: (fileId) => queue.has(fileId) || inFlight.has(fileId),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    hydrate: async (entries) => {
      const ids = entries
        .filter((entry) => entry.kind === "file" && !covers(records.get(entry.id), entry))
        .map((entry) => entry.id);
      if (ids.length === 0) return;

      const fetched = await deps.apiFetch(ids);
      const now = Date.now();
      for (const record of fetched) {
        records.set(record.fileId, { ...record, fetchedAt: now });
      }
      notify();
    },

    syncWithEntries: (entries) => {
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        if (covers(records.get(entry.id), entry)) continue;
        queue.set(entry.id, entry);
      }

      if (queue.size > 0) void pump();
    },

    cancelPending: () => {
      epoch += 1;
      queue.clear();
    },
  };
};

let excalidrawModulePromise: Promise<{
  exportToCanvas: typeof import("@excalidraw/excalidraw").exportToCanvas;
  restoreElements: typeof import("@excalidraw/excalidraw").restoreElements;
}> | null = null;

const loadExcalidraw = async () => {
  if (!excalidrawModulePromise) {
    excalidrawModulePromise = import("@excalidraw/excalidraw");
  }
  return excalidrawModulePromise;
};

const VARIANTS = [{ exportWithDarkMode: false }, { exportWithDarkMode: true }];

export const generateThumbnailPair: GenerateThumbnails = async (fileId) => {
  const content = await window.api.files.read(fileId);
  const parsed: { elements?: ExcalidrawElement[]; files?: BinaryFiles } = JSON.parse(content);

  const { exportToCanvas, restoreElements } = await loadExcalidraw();
  const elements = restoreElements(parsed.elements ?? [], null);
  const files = parsed.files ?? {};

  const canvases = await Promise.all(
    VARIANTS.map((variant) =>
      exportToCanvas({
        elements,
        appState: {
          exportBackground: true,
          viewBackgroundColor: THUMBNAIL_CANVAS_BG.light,
          exportWithDarkMode: variant.exportWithDarkMode,
        },
        files,
        maxWidthOrHeight: THUMBNAIL_MAX_SIZE,
      }),
    ),
  );

  return {
    light: canvases[0].toDataURL("image/png"),
    dark: canvases[1].toDataURL("image/png"),
  };
};

export const thumbnails: ThumbnailStore = createThumbnailStore({
  apiFetch: (ids) => window.api.thumbnails.get(ids),
  apiPut: (record) => window.api.thumbnails.put(record),
  generate: generateThumbnailPair,
});
