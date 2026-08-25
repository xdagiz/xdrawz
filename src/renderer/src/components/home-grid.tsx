import { ArrowLeftIcon, FilePlus2Icon } from "lucide-react";
import { useMemo } from "react";

import { useTheme } from "@/hooks/use-theme";
import {
  resolveThumbnailPreview,
  useThumbnailHydration,
  useThumbnailRefresh,
} from "@/hooks/use-thumbnails";
import { toAppError } from "@/lib/app-error";
import { selectRecentLibrary } from "@/lib/recent-files";
import { formatRelativeTime } from "@/lib/relative-time";
import { useStore } from "@/lib/store";
import { THUMBNAIL_CANVAS_BG } from "@/lib/thumbnails";
import { stripExcalidraw } from "@/lib/utils";

import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toast";

export const HomeGrid = () => {
  const resolvedTheme = useTheme();
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);
  const homeReturnFileId = useStore((s) => s.homeReturnFileId);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const createEntry = useStore((s) => s.createEntry);

  const recentFiles = useMemo(
    () => selectRecentLibrary(recentFileIds, entries),
    [recentFileIds, entries],
  );
  const totalDrawings = useMemo(
    () => entries.filter((entry) => entry.kind === "file").length,
    [entries],
  );
  const returnEntry = useMemo(
    () =>
      homeReturnFileId === null
        ? undefined
        : entries.find((entry) => entry.id === homeReturnFileId && entry.kind === "file"),
    [homeReturnFileId, entries],
  );

  useThumbnailRefresh();
  useThumbnailHydration(recentFiles);

  const handleCreate = async () => {
    try {
      const newId = await createEntry(null, "file");
      if (!newId) return;
      await setOpenFileId(newId);
    } catch (error) {
      const appError = toAppError(error, "create");
      toast.add({ title: appError.title, description: appError.message, type: "error" });
    }
  };

  if (recentFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FilePlus2Icon />
            </EmptyMedia>
            <EmptyTitle>No drawings yet</EmptyTitle>
            <EmptyDescription>
              Create your first drawing or pick a folder that holds .excalidraw files.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void handleCreate()}>Create drawing</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const scopeLabel =
    recentFiles.length === totalDrawings
      ? `${totalDrawings} drawing${totalDrawings === 1 ? "" : "s"}`
      : `${recentFiles.length} of ${totalDrawings} drawings`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <header className="mb-7 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {returnEntry && (
              <Button
                variant="ghost"
                size="sm"
                title={`Back to ${stripExcalidraw(returnEntry.name)}`}
                aria-label={`Back to ${stripExcalidraw(returnEntry.name)}`}
                onClick={() => void setOpenFileId(returnEntry.id)}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                Back
              </Button>
            )}
            <h2 className="text-foreground text-sm font-medium">Recent drawings</h2>
          </div>
          <p className="text-muted-foreground text-xs">{scopeLabel}</p>
        </header>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-5 gap-y-7">
          {recentFiles.map((file) => {
            const { image, pending } = resolveThumbnailPreview(file.id, resolvedTheme);
            const label = stripExcalidraw(file.name);
            const fallbackLetter = label.charAt(0).toUpperCase();

            return (
              <button
                key={file.id}
                type="button"
                title={file.name}
                onClick={() => void setOpenFileId(file.id)}
                className="group hover:bg-muted/50 focus-visible:ring-ring/50 flex flex-col items-stretch gap-2.5 rounded-lg p-2 text-left transition-colors outline-none focus-visible:ring-3"
              >
                <div
                  style={{
                    backgroundColor:
                      resolvedTheme === "dark"
                        ? THUMBNAIL_CANVAS_BG.dark
                        : THUMBNAIL_CANVAS_BG.light,
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
                    dateTime={new Date(file.modifiedAt).toISOString()}
                    className="text-muted-foreground mt-0.5 block text-xs"
                  >
                    {formatRelativeTime(file.modifiedAt)}
                  </time>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
