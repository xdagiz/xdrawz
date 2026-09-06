import type { FileEntry } from "@shared/ipc";

import { useTheme } from "@/hooks/use-theme";
import {
  resolveThumbnailPreview,
  useThumbnailHydration,
  useThumbnailRefresh,
  useThumbnailVisibility,
} from "@/hooks/use-thumbnails";
import { formatRelativeTime } from "@/lib/relative-time";
import { useStore } from "@/lib/store";
import { THUMBNAIL_CANVAS_BG } from "@/lib/thumbnails";
import { stripExcalidraw } from "@/lib/utils";

import { Skeleton } from "./ui/skeleton";

const formatDateAttr = (value: number) => {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toISOString();
  } catch {
    return "";
  }
};

export const RecentDrawings = ({ files }: { files: FileEntry[] }) => {
  const resolvedTheme = useTheme();
  const setOpenFileId = useStore((s) => s.setOpenFileId);

  useThumbnailRefresh();
  useThumbnailHydration(files);

  const observeTile = useThumbnailVisibility();

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-5 gap-y-7">
      {files.map((file) => {
        const { image, pending } = resolveThumbnailPreview(file.id, resolvedTheme);
        const label = stripExcalidraw(file.name);
        const fallbackLetter = label.charAt(0).toUpperCase();

        return (
          <button
            key={file.id}
            type="button"
            title={file.name}
            ref={observeTile(file.id)}
            onClick={() => void setOpenFileId(file.id)}
            className="group hover:bg-muted/50 focus-visible:ring-ring/50 flex flex-col items-stretch gap-2.5 rounded-lg p-2 text-left transition-colors outline-none focus-visible:ring-3"
          >
            <div
              style={{
                backgroundColor:
                  resolvedTheme === "dark" ? THUMBNAIL_CANVAS_BG.dark : THUMBNAIL_CANVAS_BG.light,
              }}
              className="border-border/60 group-hover:border-muted-foreground/40 relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border transition-colors"
            >
              {image ? (
                <img
                  src={image}
                  alt=""
                  className="size-full object-contain p-2"
                  draggable={false}
                />
              ) : pending ? (
                <Skeleton className="size-full" />
              ) : (
                <span className="text-muted-foreground/40 text-3xl font-medium">
                  {fallbackLetter}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{label}</p>
              <time
                dateTime={formatDateAttr(file.modifiedAt)}
                className="text-muted-foreground mt-0.5 block text-xs"
              >
                {formatRelativeTime(file.modifiedAt)}
              </time>
            </div>
          </button>
        );
      })}
    </div>
  );
};
