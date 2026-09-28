import type { FileEntry } from "@shared/ipc";

import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/hooks/use-theme";
import {
  resolveThumbnailPreview,
  useThumbnailHydration,
  useThumbnailRefresh,
  useThumbnailVisibility,
} from "@/hooks/use-thumbnails";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useStore } from "@/lib/store";
import { THUMBNAIL_CANVAS_BG } from "@/lib/thumbnails";
import { formatFileSize, stripExcalidraw } from "@/lib/utils";

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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-6">
      {files.map((file) => {
        const { image, pending } = resolveThumbnailPreview(file.id, resolvedTheme);
        const label = stripExcalidraw(file.name);
        const fallbackLetter = label.charAt(0).toUpperCase();

        return (
          <button
            key={file.id}
            type="button"
            title={label}
            ref={observeTile(file.id)}
            onClick={() => void setOpenFileId(file.id)}
            className="group focus-visible:ring-ring/50 focus-visible:ring-1.5 flex flex-col items-stretch gap-2 rounded-lg p-1.5 text-left transition-colors outline-none"
          >
            <div
              style={{
                backgroundColor:
                  resolvedTheme === "dark" ? THUMBNAIL_CANVAS_BG.dark : THUMBNAIL_CANVAS_BG.light,
              }}
              className="border-border-quiet group-hover:border-border-strong relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border shadow-[var(--shadow-raised)] transition-colors"
            >
              {image ? (
                <img
                  src={image}
                  alt=""
                  loading="lazy"
                  decoding="async"
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
            <div className="min-w-0 px-0.5">
              <p className="truncate text-sm font-medium">{label}</p>
              <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                <time
                  dateTime={formatDateAttr(file.modifiedAt)}
                  title={new Date(file.modifiedAt).toLocaleString()}
                >
                  {formatRelativeTimeShort(file.modifiedAt)}
                </time>
                {` · ${formatFileSize(file.size)}`}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
};
