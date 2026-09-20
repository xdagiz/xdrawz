import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";

import { useListBottomFade } from "@/hooks/use-list-bottom-fade";
import { buildDrawingSearchEntries, rankDrawingHits, type DrawingRow } from "@/lib/drawing-search";
import { useStore } from "@/lib/store";

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MAX_HITS = 20;

export const DrawingRowItem = memo(function DrawingRowItem({
  row,
  onChoose,
}: {
  row: DrawingRow;
  onChoose: (fileId: string) => void;
}) {
  return (
    <CommandItem
      value={`entry:${row.id}`}
      disabled={row.disabled}
      title={row.folderPath ? `${row.folderPath}/${row.label}` : row.label}
      onClick={() => {
        if (!row.disabled) onChoose(row.id);
      }}
    >
      {row.folderPath ? (
        <span className="flex min-w-0 flex-1 items-baseline">
          <span className="min-w-0 truncate">{row.folderPath}/</span>
          <span className="shrink-0">{row.label}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
      )}
    </CommandItem>
  );
});

export const DrawingSearch = ({ open, onOpenChange }: Props) => {
  const [query, setQuery] = useState("");
  const externalConflict = useStore((s) => s.externalConflict);
  const entries = useStore((s) => s.entries);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const { listRef, bottomFade, updateBottomFade } = useListBottomFade(open);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setQuery("");
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const conflictActive = externalConflict !== null;
  const conflictFileId = externalConflict?.fileId ?? null;
  const trimmedQuery = useDeferredValue(query).trim();

  const drawingSearchEntries = useMemo(() => buildDrawingSearchEntries(entries), [entries]);

  const drawingHits = useMemo(
    () =>
      rankDrawingHits({
        query: trimmedQuery,
        entries: drawingSearchEntries,
        conflictActive,
        conflictFileId,
        maxHits: MAX_HITS,
      }),
    [trimmedQuery, drawingSearchEntries, conflictActive, conflictFileId],
  );

  const chooseDrawing = async (fileId: string) => {
    try {
      await setOpenFileId(fileId);
    } finally {
      onOpenChange(false);
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Search drawings"
      description="Search drawings"
      className="gap-0 sm:max-w-[40rem]"
    >
      <Command value={query} onValueChange={setQuery}>
        <CommandInput placeholder="Search drawings..." />
        <CommandPanel className="h-72 min-h-0">
          {drawingHits.length === 0 ? (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-muted-foreground py-6 text-center text-sm"
            >
              No results found.
            </div>
          ) : (
            <CommandList
              ref={listRef}
              onScroll={updateBottomFade}
              className={`h-full min-h-0 px-1 ${
                bottomFade
                  ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
                  : ""
              }`}
            >
              <CommandGroup items={drawingHits}>
                <CommandGroupLabel>Drawings</CommandGroupLabel>
                <CommandCollection>
                  {(row: DrawingRow) => (
                    <DrawingRowItem key={row.id} row={row} onChoose={chooseDrawing} />
                  )}
                </CommandCollection>
              </CommandGroup>
            </CommandList>
          )}
        </CommandPanel>
        <CommandFooter>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>
              <ArrowUpIcon />
              <ArrowDownIcon />
            </Kbd>
            <span>Navigate</span>
          </KbdGroup>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>⏎</Kbd>
            <span>Select</span>
          </KbdGroup>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span>Close</span>
          </KbdGroup>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
};
