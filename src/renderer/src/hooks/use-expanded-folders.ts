import { useCallback, useEffect, useState } from "react";

import { readExpandedFolderIds, writeExpandedFolderIds } from "@/lib/tree";

export type TreeIdsUpdate = string[] | ((old: string[]) => string[]);

export const useExpandedFolders = () => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set<string>() : readExpandedFolderIds(window.localStorage),
  );

  useEffect(() => {
    writeExpandedFolderIds(window.localStorage, expandedIds);
  }, [expandedIds]);

  const expandIds = useCallback((ids: Iterable<string>) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      let changed = false;

      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, []);

  const setExpandedItems = useCallback((idsOrUpdater: TreeIdsUpdate) => {
    setExpandedIds((prev) => {
      const next =
        typeof idsOrUpdater === "function" ? idsOrUpdater(Array.from(prev)) : idsOrUpdater;
      return new Set(next);
    });
  }, []);

  return { expandedIds, expandIds, setExpandedItems };
};
