import type { FileEntry } from "@shared/ipc";

import { rankEntries } from "@/lib/fuzzy-rank";
import { ancestorIdsOf } from "@/lib/tree";
import { stripExcalidraw } from "@/lib/utils";

export type DrawingSearchEntry = {
  id: string;
  label: string;
  folderPath: string;
  modifiedAt: number;
};

export type DrawingRow = {
  id: string;
  label: string;
  folderPath: string;
  disabled: boolean;
};

export const buildDrawingSearchEntries = (entries: FileEntry[]): DrawingSearchEntry[] => {
  const folderLabelById = new Map(
    entries.filter((entry) => entry.kind === "directory").map((entry) => [entry.id, entry.name]),
  );

  return entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({
      id: entry.id,
      label: stripExcalidraw(entry.name),
      folderPath: ancestorIdsOf(entry.id)
        .map((ancestorId) => folderLabelById.get(ancestorId) ?? ancestorId)
        .join("/"),
      modifiedAt: entry.modifiedAt,
    }));
};

export const rankDrawingHits = ({
  query,
  entries,
  conflictActive,
  conflictFileId,
  maxHits,
}: {
  query: string;
  entries: DrawingSearchEntry[];
  conflictActive: boolean;
  conflictFileId: string | null;
  maxHits: number;
}): DrawingRow[] => {
  const hits =
    query.length === 0
      ? entries.toSorted((a, b) => b.modifiedAt - a.modifiedAt).slice(0, maxHits)
      : rankEntries(
          query,
          entries,
          (entry) => (entry.folderPath ? `${entry.folderPath}/${entry.label}` : entry.label),
          (entry) => entry.modifiedAt,
        ).slice(0, maxHits);

  return hits.map((file) => ({
    id: file.id,
    label: file.label,
    folderPath: file.folderPath,
    disabled: conflictActive && file.id === conflictFileId,
  }));
};
