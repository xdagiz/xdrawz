import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileEntry, ThumbnailRecord } from "@shared/ipc";
import { MAX_THUMBNAIL_BATCH } from "@shared/ipc";

import type { ResolvedTheme } from "@/lib/theme";
import { createSlotPump } from "@/lib/thumbnail-scheduler";

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
  setVisible: (fileId: string, visible: boolean) => void;
  force: (entry: FileEntry) => void;
  cancelPending: () => void;
};

export const THUMBNAIL_MAX_SIZE = 200;
export const THUMBNAIL_MAX_QUEUE = 300;

const MIN_REMAINING_MS = 4;

export const THUMBNAIL_CANVAS_BG = {
  light: "#ffffff",
  dark: "#121212",
};

const covers = (record: CacheEntry | undefined, entry: FileEntry) =>
  record !== undefined && record.mtimeMs === entry.modifiedAt && record.size === entry.size;

export const pickThumbnailVariant = (
  record: Pick<ThumbnailRecord, "light" | "dark">,
  resolvedTheme: ResolvedTheme,
) => (resolvedTheme === "dark" ? record.dark : record.light);

export const createThumbnailStore = (deps: ThumbnailStoreDeps): ThumbnailStore => {
  const records = new Map<string, CacheEntry>();
  const listeners = new Set<() => void>();
  const queue = new Map<string, FileEntry>();
  const inFlight = new Set<string>();
  const visible = new Set<string>();
  const known = new Map<string, FileEntry>();

  let epoch = 0;
  let running = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const generateOne = async (entry: FileEntry, myEpoch: number) => {
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
  };

  const drain = async (deadline?: { timeRemaining: () => number }) => {
    if (running) return;

    running = true;
    const myEpoch = epoch;

    try {
      let skips = 0;

      do {
        if (myEpoch !== epoch) return;
        if (queue.size === 0) return;
        if (skips >= queue.size) break;

        const next = queue.values().next();
        if (next.done) return;
        const entry = next.value;

        if (!visible.has(entry.id)) {
          queue.delete(entry.id);
          queue.set(entry.id, entry);
          skips += 1;
          continue;
        }

        queue.delete(entry.id);
        await generateOne(entry, myEpoch);

        if (deadline && deadline.timeRemaining() <= MIN_REMAINING_MS && queue.size > 0) {
          return;
        }
      } while (queue.size > 0);
    } finally {
      running = false;
      if (queue.size > 0 && myEpoch === epoch) slotPump.kick();
    }
  };

  const slotPump = createSlotPump({ drain: (deadline) => void drain(deadline) });

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
      const byId = new Map(
        entries.filter((entry) => entry.kind === "file").map((entry) => [entry.id, entry] as const),
      );
      const ids = entries
        .filter((entry) => entry.kind === "file" && !covers(records.get(entry.id), entry))
        .map((entry) => entry.id);
      if (ids.length === 0) return;

      const now = Date.now();
      for (let i = 0; i < ids.length; i += MAX_THUMBNAIL_BATCH) {
        const slice = await deps.apiFetch(ids.slice(i, i + MAX_THUMBNAIL_BATCH));
        for (const record of slice) {
          const entry = byId.get(record.fileId);
          if (entry && covers(records.get(record.fileId), entry)) continue;
          if (entry && (record.mtimeMs !== entry.modifiedAt || record.size !== entry.size))
            continue;
          records.set(record.fileId, { ...record, fetchedAt: now });
        }
      }
      notify();
    },

    syncWithEntries: (entries) => {
      const present = new Set<string>();
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        present.add(entry.id);
      }
      for (const id of records.keys()) {
        if (!present.has(id)) records.delete(id);
      }
      for (const id of known.keys()) {
        if (!present.has(id)) known.delete(id);
      }
      for (const id of queue.keys()) {
        if (!present.has(id)) queue.delete(id);
      }
      while (records.size > 1000) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      while (known.size > 1000) {
        const oldest = known.keys().next().value;
        if (oldest === undefined) break;
        known.delete(oldest);
      }
      for (const entry of entries) {
        if (entry.kind !== "file") continue;
        known.set(entry.id, entry);
        if (covers(records.get(entry.id), entry)) continue;
        if (!visible.has(entry.id)) continue;
        if (queue.size >= THUMBNAIL_MAX_QUEUE) break;
        queue.set(entry.id, entry);
      }

      if (queue.size > 0) slotPump.kick();
    },

    setVisible: (fileId, isVisible) => {
      if (isVisible) {
        if (visible.has(fileId)) visible.delete(fileId);
        else if (visible.size >= 1000) {
          const oldest = visible.values().next().value;
          if (oldest !== undefined) visible.delete(oldest);
        }
        visible.add(fileId);
      } else visible.delete(fileId);

      if (!isVisible) return;

      const entry = known.get(fileId);
      if (!entry || covers(records.get(fileId), entry)) return;
      if (queue.has(fileId) || inFlight.has(fileId)) return;

      queue.set(fileId, entry);
      slotPump.kick();
    },

    force: (entry) => {
      known.set(entry.id, entry);
      if (covers(records.get(entry.id), entry)) return;
      if (inFlight.has(entry.id)) return;

      queue.delete(entry.id);
      const myEpoch = epoch;
      void generateOne(entry, myEpoch).then(() => {
        if (myEpoch !== epoch) return;
        if (queue.size > 0) slotPump.kick();
      });
    },

    cancelPending: () => {
      epoch += 1;
      queue.clear();
      slotPump.cancel();
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

  const light = canvases[0].toDataURL("image/png");
  const dark = canvases[1].toDataURL("image/png");
  for (const canvas of canvases) {
    canvas.width = 0;
    canvas.height = 0;
  }

  return {
    light,
    dark,
  };
};

export const thumbnails = createThumbnailStore({
  apiFetch: (ids) => window.api.thumbnails.get(ids),
  apiPut: (record) => window.api.thumbnails.put(record),
  generate: generateThumbnailPair,
});
