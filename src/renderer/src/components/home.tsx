import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { RecentDrawings } from "./recent-drawings";
import { Button } from "./ui/button";

export const Home = () => {
  const { recentFiles } = useRecentDrawings();
  const entries = useStore((s) => s.entries);
  const homeReturnFileId = useStore((s) => s.homeReturnFileId);
  const setOpenFileId = useStore((s) => s.setOpenFileId);

  const returnEntry = useMemo(
    () =>
      homeReturnFileId === null
        ? undefined
        : entries.find((entry) => entry.id === homeReturnFileId && entry.kind === "file"),
    [homeReturnFileId, entries],
  );

  return (
    <div className="thin-scroll h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <header className="mb-7 flex flex-col gap-3">
          {returnEntry && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground -ml-2"
                title={`Back to ${stripExcalidraw(returnEntry.name)}`}
                aria-label={`Back to ${stripExcalidraw(returnEntry.name)}`}
                onClick={() => void setOpenFileId(returnEntry.id)}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                <span className="max-w-64 truncate">{stripExcalidraw(returnEntry.name)}</span>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <h2 className="text-foreground text-xl font-semibold tracking-tight">
              Recent drawings
            </h2>
          </div>
        </header>
        <RecentDrawings files={recentFiles} />
      </div>
    </div>
  );
};
