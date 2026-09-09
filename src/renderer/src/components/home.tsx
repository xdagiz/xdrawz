import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { toAppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { EmptyDrawings } from "./empty-drawings";
import { RecentDrawings } from "./recent-drawings";
import { Button } from "./ui/button";
import { toast } from "./ui/toast";

export const Home = () => {
  const { recentFiles } = useRecentDrawings();
  const entries = useStore((s) => s.entries);
  const homeReturnFileId = useStore((s) => s.homeReturnFileId);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const createEntry = useStore((s) => s.createEntry);

  const returnEntry = useMemo(
    () =>
      homeReturnFileId === null
        ? undefined
        : entries.find((entry) => entry.id === homeReturnFileId && entry.kind === "file"),
    [homeReturnFileId, entries],
  );

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
        <EmptyDrawings
          action={<Button onClick={() => void handleCreate()}>Create drawing</Button>}
        />
      </div>
    );
  }

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
