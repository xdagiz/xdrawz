import { useMemo } from "react";

import { selectRecentLibrary, selectSwitcherCandidates } from "@/lib/recent-files";
import { useStore } from "@/lib/store";

export const useRecentDrawings = (limit?: number) => {
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);
  const showRecents = useStore((s) => s.settings.showRecents);

  const recentFiles = useMemo(
    () => (showRecents ? selectRecentLibrary(recentFileIds, entries, limit) : []),
    [showRecents, recentFileIds, entries, limit],
  );

  const totalDrawings = useMemo(
    () => entries.filter((entry) => entry.kind === "file").length,
    [entries],
  );

  return { recentFiles, totalDrawings };
};

export const useSwitcherCandidates = () => {
  const entries = useStore((s) => s.entries);
  const recentFileIds = useStore((s) => s.recentFileIds);

  return useMemo(() => selectSwitcherCandidates(recentFileIds, entries), [recentFileIds, entries]);
};
