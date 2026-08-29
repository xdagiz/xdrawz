import type { FileEntry } from "@shared/ipc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export const useThumbnailRefresh = () => {
  const [_tick, setTick] = useState(0);
  useEffect(() => thumbnails.subscribe(() => setTick((tick) => tick + 1)), []);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
};

export const useThumbnailVisibility = (): ((
  fileId: string,
) => (element: HTMLElement | null) => void) => {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedRef = useRef(new Map<string, HTMLElement>());
  const callbacksRef = useRef(new Map<string, (element: HTMLElement | null) => void>());

  const getObserver = () => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const fileId = entry.target.dataset.thumbnailId;
          if (fileId) thumbnails.setVisible(fileId, entry.isIntersecting);
        }
      });
    }
    return observerRef.current;
  };

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current.clear();
      callbacksRef.current.clear();
    },
    [],
  );

  return useCallback((fileId: string) => {
    let callback = callbacksRef.current.get(fileId);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        const observer = getObserver();
        if (element) {
          element.dataset.thumbnailId = fileId;
          observedRef.current.set(fileId, element);
          observer.observe(element);
        } else {
          const observed = observedRef.current.get(fileId);
          if (observed) observer.unobserve(observed);
          observedRef.current.delete(fileId);
          thumbnails.setVisible(fileId, false);
        }
      };
      callbacksRef.current.set(fileId, callback);
    }
    return callback;
  }, []);
};

export const useThumbnailHydration = (files: FileEntry[]) => {
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
