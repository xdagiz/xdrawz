import type { FileEntry } from "@shared/ipc";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ResolvedTheme } from "@/lib/theme";
import { pickThumbnailVariant, thumbnails } from "@/lib/thumbnails";

const REFRESH_INTERVAL_MS = 60_000;

export type ThumbnailPreview = {
  image: string | undefined;
  pending: boolean;
};

export const resolveThumbnailPreview = (
  fileId: string,
  resolvedTheme: ResolvedTheme,
): ThumbnailPreview => {
  const record = thumbnails.getRecord(fileId);
  return {
    image: record ? pickThumbnailVariant(record, resolvedTheme) : undefined,
    pending: !record && thumbnails.isPending(fileId),
  };
};

export const useThumbnailRefresh = (): void => {
  const [, setTick] = useState(0);

  useEffect(() => thumbnails.subscribe(() => setTick((tick) => tick + 1)), []);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
};

export const useThumbnailHydration = (files: FileEntry[]): void => {
  const filesRef = useRef(files);
  filesRef.current = files;

  const fingerprint = useMemo(
    () =>
      files
        .filter((entry) => entry.kind === "file")
        .map((entry) => `${entry.id}?${entry.modifiedAt}:${entry.size}`)
        .join("|"),
    [files],
  );

  useEffect(() => {
    const current = filesRef.current.filter((entry) => entry.kind === "file");
    if (current.length === 0) return undefined;

    void thumbnails
      .hydrate(current)
      .then(() => {
        thumbnails.syncWithEntries(current);
      })
      .catch((error) => console.error("thumbnail hydration failed", error));

    return () => thumbnails.cancelPending();
  }, [fingerprint]);
};
