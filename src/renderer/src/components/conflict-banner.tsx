import { TriangleAlertIcon } from "lucide-react";

import { fileNameOf } from "@/lib/conflicts";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { Button } from "./ui/button";

export const ConflictBanner = () => {
  const conflict = useStore((s) => s.externalConflict);
  const entries = useStore((s) => s.entries);
  if (!conflict) return null;

  const name = stripExcalidraw(fileNameOf(entries, conflict.fileId));

  if (conflict.type === "changed") {
    return (
      <div
        role="status"
        className="text-foreground flex items-center gap-3 border-b bg-amber-500/10 px-4 py-2 text-sm"
      >
        <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1 truncate">
          {`"${name}" was changed on disk. Your edits differ from the saved file.`}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => useStore.getState().reloadOpenFileFromDisk()}
        >
          Reload from disk
        </Button>
        <Button size="sm" onClick={() => void useStore.getState().overwriteOpenFileFromSession()}>
          Keep my changes
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="text-foreground flex items-center gap-3 border-b bg-amber-500/10 px-4 py-2 text-sm"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 truncate">
        {`"${name}" was deleted on disk. You still have unsaved edits.`}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void useStore.getState().recoverMissingOpenFile()}
      >
        Recover file
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => useStore.getState().discardMissingOpenFile()}
      >
        Discard changes
      </Button>
    </div>
  );
};
