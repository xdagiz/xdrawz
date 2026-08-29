import { useMemo } from "react";

import { selectRecentLibrary } from "@/lib/recent-files";
import { useStore } from "@/lib/store";

export const useRecentDrawings = (limit?: number) => {
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);

  const recentFiles = useMemo(
    () => selectRecentLibrary(recentFileIds, entries, limit),
    [recentFileIds, entries, limit],
  );

  const totalDrawings = useMemo(
    () => entries.filter((entry) => entry.kind === "file").length,
    [entries],
  );

  return { recentFiles, totalDrawings };
};
