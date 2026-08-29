import type { FileEntry } from "@shared/ipc";
import { useEffect } from "react";

import { useTheme } from "@/hooks/use-theme";
import {
  resolveThumbnailPreview,
  useThumbnailHydration,
  useThumbnailRefresh,
} from "@/hooks/use-thumbnails";
import { selectRecentLibrary } from "@/lib/recent-files";
import { useStore } from "@/lib/store";
import { THUMBNAIL_CANVAS_BG, thumbnails } from "@/lib/thumbnails";
import { stripExcalidraw } from "@/lib/utils";

import { Skeleton } from "./ui/skeleton";

type DrawingSwitcherProps = {
  index: number;
  commitAt: (index: number) => void;
  onCancel: () => void;
};

const labelOf = (entry: FileEntry) => stripExcalidraw(entry.name);

export const DrawingSwitcher = ({ index, commitAt, onCancel }: DrawingSwitcherProps) => {
  const resolvedTheme = useTheme();
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);

  const candidates = selectRecentLibrary(recentFileIds, entries);

  useThumbnailRefresh();
  useThumbnailHydration(candidates);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const highlighted = Math.min(Math.max(index, 0), candidates.length - 1);
  const focusEntry = candidates[highlighted];
  const focusCandidate = focusEntry && candidates.find((entry) => entry.id === focusEntry.id);

  useEffect(() => {
    if (focusCandidate) thumbnails.force(focusCandidate);
  }, [focusCandidate]);

  if (!focusEntry) return null;

  const canvasBg = resolvedTheme === "dark" ? THUMBNAIL_CANVAS_BG.dark : THUMBNAIL_CANVAS_BG.light;
  const focusPreview = resolveThumbnailPreview(focusEntry.id, resolvedTheme);

  return (
    <div
      className="animate-in fade-in bg-popover/40 fixed inset-0 z-50 flex items-center justify-center p-6 duration-150 motion-reduce:animate-none"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-label="Switch drawing"
        className="animate-in fade-in zoom-in-95 bg-popover/90 text-popover-foreground w-full max-w-md rounded-xl border p-4 shadow-2xl backdrop-blur-xl duration-150 outline-none motion-reduce:animate-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-3">
          <div
            className="border-border/60 flex aspect-[4/3] max-h-52 w-full items-center justify-center overflow-hidden rounded-lg border"
            style={{ backgroundColor: canvasBg }}
          >
            {focusPreview.image ? (
              <img
                src={focusPreview.image}
                alt=""
                draggable={false}
                className="size-full object-contain p-2"
              />
            ) : focusPreview.pending ? (
              <Skeleton className="bg-muted size-full rounded-lg" />
            ) : (
              <span className="text-foreground/40 text-4xl font-medium">
                {labelOf(focusEntry).charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <p className="truncate text-center text-sm font-medium">{labelOf(focusEntry)}</p>

          <div className="flex flex-wrap justify-center gap-1.5">
            {candidates.map((entry, tileIndex) => {
              const preview = resolveThumbnailPreview(entry.id, resolvedTheme);
              const activeTile = tileIndex === highlighted;
              return (
                <button
                  key={entry.id}
                  type="button"
                  title={labelOf(entry)}
                  onClick={() => commitAt(tileIndex)}
                  className={`flex w-[calc((100%-1.5rem)/5)] flex-col items-stretch gap-1 rounded-md border p-1 outline-none ${
                    activeTile
                      ? "border-foreground/60 bg-foreground/10 ring-foreground/40 ring-1"
                      : "border-border/60 bg-foreground/[0.04] opacity-50 hover:opacity-90"
                  }`}
                >
                  <span
                    className="flex h-9 items-center justify-center overflow-hidden rounded-sm"
                    style={{ backgroundColor: canvasBg }}
                  >
                    {preview.image ? (
                      <img
                        src={preview.image}
                        alt=""
                        draggable={false}
                        className="max-h-full max-w-full object-contain p-0.5"
                      />
                    ) : (
                      <span className="text-foreground/40 text-xs font-medium">
                        {labelOf(entry).charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground truncate text-[10px]">
                    {labelOf(entry)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
