import { formatForDisplay } from "@tanstack/react-hotkeys";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildCommands, type CommandContext, type CommandDef } from "@/lib/commands";
import { rankEntries } from "@/lib/fuzzy-rank";
import { sessionOwner } from "@/lib/session-owner";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { CommandDeleteDialog, CommandRenameDialog } from "./command-dialogs";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";
import { useSidebar } from "./ui/sidebar";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MAX_HITS_PER_SOURCE = 8;

export const CommandPalette = ({ open, onOpenChange }: Props) => {
  const [query, setQuery] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const settingsDialogOpen = useStore((s) => s.settingsDialogOpen);
  const setSettingsDialogOpen = useStore((s) => s.setSettingsDialogOpen);
  const externalConflict = useStore((s) => s.externalConflict);
  const entries = useStore((s) => s.entries);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const { toggleSidebar } = useSidebar();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [bottomFade, setBottomFade] = useState(false);

  const updateBottomFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setBottomFade(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    updateBottomFade();
  }, [updateBottomFade, open, query, entries, externalConflict]);

  useEffect(() => {
    if (open && settingsDialogOpen) setSettingsDialogOpen(false);
  }, [open, settingsDialogOpen, setSettingsDialogOpen]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const commands = useMemo(
    () =>
      buildCommands({
        openSettings: () => setSettingsDialogOpen(true),
        openRenameDialog: () => setRenameOpen(true),
        openDeleteDialog: () => setDeleteOpen(true),
        toggleSidebar,
      }),
    [setSettingsDialogOpen, toggleSidebar],
  );

  const conflictActive = externalConflict !== null;
  const trimmedQuery = query.trim();
  const ctx: CommandContext = {
    store: useStore.getState(),
    session: sessionOwner.getSession(),
  };

  const visibleCommands = commands.filter(
    (command) => !(conflictActive && command.gatedOnConflict) && command.enabled?.(ctx) !== false,
  );

  const commandHits =
    trimmedQuery.length === 0
      ? visibleCommands
      : rankEntries(
          trimmedQuery,
          visibleCommands,
          (command) => `${command.title} ${(command.keywords ?? []).join(" ")}`,
          () => 0,
        ).slice(0, MAX_HITS_PER_SOURCE);

  const drawingHits = useMemo(() => {
    if (trimmedQuery.length === 0) {
      return [...entries]
        .filter((entry) => entry.kind === "file")
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, MAX_HITS_PER_SOURCE);
    }
    return rankEntries(
      trimmedQuery,
      entries.filter((entry) => entry.kind === "file"),
      (entry) => stripExcalidraw(entry.name),
      (entry) => entry.modifiedAt,
    ).slice(0, MAX_HITS_PER_SOURCE);
  }, [trimmedQuery, entries]);

  const runCommand = async (command: CommandDef) => {
    try {
      await command.perform({
        store: useStore.getState(),
        session: sessionOwner.getSession(),
      });
    } finally {
      onOpenChange(false);
    }
  };

  const chooseDrawing = async (fileId: string) => {
    try {
      await setOpenFileId(fileId);
    } finally {
      onOpenChange(false);
    }
  };

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        description="Search drawings and commands"
        className="sm:max-w-[40rem]"
      >
        <Command shouldFilter={false} className="gap-0 p-0!">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search drawings and commands..."
          />
          <CommandList
            ref={listRef}
            onScroll={updateBottomFade}
            className={`h-96 px-1 ${
              bottomFade
                ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]"
                : ""
            }`}
          >
            {conflictActive && (
              <p className="text-destructive px-3 pb-2 text-xs font-medium">
                File commands are limited until the conflict is resolved in its dialog
              </p>
            )}
            <CommandEmpty>No results found.</CommandEmpty>
            {commandHits.length > 0 && (
              <CommandGroup heading="Actions">
                {commandHits.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={`command:${command.id}`}
                    disabled={conflictActive && command.gatedOnConflict === true}
                    onSelect={() => void runCommand(command)}
                  >
                    <command.icon className="text-muted-foreground" />
                    <span>
                      {command.title}
                      {command.titleSuffix?.(ctx) ?? ""}
                    </span>
                    {command.shortcut && (
                      <CommandShortcut>{formatForDisplay(command.shortcut)}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            {drawingHits.length > 0 && (
              <CommandGroup heading="Drawings">
                {drawingHits.map((file) => (
                  <CommandItem
                    key={file.id}
                    value={`entry:${file.id}`}
                    disabled={conflictActive && file.id === (externalConflict?.fileId ?? null)}
                    onSelect={() => void chooseDrawing(file.id)}
                  >
                    <span>{stripExcalidraw(file.name)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <div className="text-muted-foreground border-border-quiet bg-foreground/[0.025] [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground flex items-center gap-3 border-t px-4 py-2.5 text-sm font-medium">
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
          </div>
        </Command>
      </CommandDialog>
      <CommandRenameDialog open={renameOpen} onOpenChange={setRenameOpen} />
      <CommandDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
};
