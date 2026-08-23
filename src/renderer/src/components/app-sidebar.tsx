import type { FileDeleteMode } from "@shared/ipc";
import { isAncestorId } from "@shared/ipc";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { TreeContainer, TreeRow, useFileTree, type FileTreeItem } from "@/components/ui/tree";
import { useExpandedFolders } from "@/hooks/use-expanded-folders";
import { toAppError, type AppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";
import {
  TYPEAHEAD_RESET_MS,
  ancestorIdsOf,
  buildEntriesById,
  buildSortedChildIndex,
  findTypeaheadMatch,
} from "@/lib/tree";
import { stripExcalidraw } from "@/lib/utils";

import { toast } from "./ui/toast";

const isTypeaheadChar = (event: React.KeyboardEvent<HTMLDivElement>): boolean =>
  event.key !== " " && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

export const AppSidebar = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const renameEntry = useStore((s) => s.renameEntry);
  const createEntry = useStore((s) => s.createEntry);
  const deleteEntry = useStore((s) => s.deleteEntry);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<AppError | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    mode: FileDeleteMode;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const typeahead = useRef({ buffer: "", at: 0 });

  const entriesById = useMemo(() => buildEntriesById(entries), [entries]);
  const childIndex = useMemo(() => buildSortedChildIndex(entries), [entries]);
  const { expandedIds, expandIds, setExpandedItems } = useExpandedFolders();
  const expandedItems = useMemo(() => Array.from(expandedIds), [expandedIds]);
  const selectedItems = useMemo(() => (openFileId ? [openFileId] : []), [openFileId]);

  const openDrawing = useCallback(
    async (fileId: string) => {
      if (fileId !== useStore.getState().openFileId) {
        await setOpenFileId(fileId);
        if (useStore.getState().openFileId !== fileId) return;
      }
    },
    [setOpenFileId],
  );

  const handlePrimaryAction = useCallback(
    (item: FileTreeItem) => {
      const entry = item.getItemData();
      if (entry && entry.kind === "file") {
        void openDrawing(entry.id);
      }
    },
    [openDrawing],
  );

  const ignoreSelectionChange = useCallback(() => {}, []);

  const tree = useFileTree({
    childIndex,
    expandedItems,
    onExpandedItemsChange: setExpandedItems,
    selectedItems,
    onSelectedItemsChange: ignoreSelectionChange,
    onPrimaryAction: handlePrimaryAction,
  });

  useEffect(() => {
    tree.rebuildTree();
  }, [tree, childIndex]);

  useEffect(() => {
    if (!openFileId || entries.length === 0) return;
    expandIds(ancestorIdsOf(openFileId));
  }, [openFileId, expandIds, entries.length]);

  useEffect(() => {
    let innerFrame = 0;
    let outerFrame = 0;

    if (openFileId && entries.length > 0) {
      outerFrame = requestAnimationFrame(() => {
        innerFrame = requestAnimationFrame(() => {
          const item = tree.getItemInstance(openFileId);
          void item?.scrollTo({ block: "nearest" }).catch(() => {});
        });
      });
    }

    return () => {
      cancelAnimationFrame(outerFrame);
      cancelAnimationFrame(innerFrame);
    };
  }, [openFileId, tree, entries.length]);

  const performDelete = useCallback(
    async (target: { id: string; name: string; mode: FileDeleteMode }) => {
      try {
        const ok = await deleteEntry(target.id, target.mode);
        if (ok) toast.add({ title: `Deleted ${target.name}`, type: "success" });
      } catch (error) {
        toast.add({ title: toAppError(error, "delete").message, type: "error" });
      }
    },
    [deleteEntry],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;

    await performDelete(deleteTarget);
    setDeleteOpen(false);
  }, [deleteTarget, performDelete]);

  const startRename = useCallback((fileId: string) => {
    setRenameError(null);
    setRenamingId(fileId);
  }, []);

  const freshDrawingIdRef = useRef<string | null>(null);

  const clearFreshMarker = useCallback((fileId: string) => {
    if (freshDrawingIdRef.current === fileId) freshDrawingIdRef.current = null;
  }, []);

  const handleCreate = useCallback(
    async (parentId: string | null, kind: "file" | "directory") => {
      try {
        const newId = await createEntry(parentId, kind);
        if (!newId) return;
        if (kind === "file") freshDrawingIdRef.current = newId;
        expandIds(ancestorIdsOf(newId));
        setRenameError(null);
        setRenamingId(newId);
      } catch (error) {
        const appError = toAppError(error, "create");
        toast.add({ title: appError.title, description: appError.message, type: "error" });
      }
    },
    [createEntry, expandIds],
  );

  const openRootMenu = useCallback(
    async (x: number, y: number) => {
      const id = await window.api.contextMenu.show(
        [
          { id: "new-drawing", label: "New drawing" },
          { id: "new-folder", label: "New folder" },
        ],
        x,
        y,
      );
      if (id === "new-drawing") void handleCreate(null, "file");
      if (id === "new-folder") void handleCreate(null, "directory");
    },
    [handleCreate],
  );

  useHotkey("Mod+N", () => void handleCreate(null, "file"));
  useHotkey("Mod+Shift+N", () => void handleCreate(null, "directory"));

  const openDelete = useCallback(
    (id: string, name: string, mode: FileDeleteMode) => {
      const state = useStore.getState();
      const currentOpenId = state.openFileId;
      const containsOpenDirty =
        currentOpenId !== null &&
        state.dirtyById[currentOpenId] !== undefined &&
        (id === currentOpenId || isAncestorId(id, currentOpenId));

      if (containsOpenDirty) {
        toast.add({
          title: "Couldn’t delete",
          description: "The folder contains the open drawing with unsaved changes. Close it first.",
          type: "error",
        });
        return;
      }

      if (mode !== "permanent") {
        void performDelete({ id, name, mode });
        return;
      }

      setDeleteTarget({ id, name, mode });
      setDeleteOpen(true);
    },
    [performDelete],
  );

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;

      const items = tree.getItems();
      const focusedIndex = items.findIndex((item) => item.isFocused());
      if (focusedIndex === -1) return;

      const entry = items[focusedIndex].getItemData();
      if (!entry) return;

      if (event.key === "F2") {
        event.preventDefault();
        startRename(entry.id);
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        const mode: FileDeleteMode = event.shiftKey ? "permanent" : "trash";
        openDelete(entry.id, stripExcalidraw(entry.name), mode);
        return;
      }

      if (!isTypeaheadChar(event)) return;
      event.preventDefault();

      const now = Date.now();
      typeahead.current.buffer =
        now - typeahead.current.at > TYPEAHEAD_RESET_MS
          ? event.key
          : typeahead.current.buffer + event.key;
      typeahead.current.at = now;

      const names = items.map((item) => item.getItemName());
      const hit = findTypeaheadMatch(names, focusedIndex, typeahead.current.buffer);
      if (hit !== null) {
        items[hit].setFocused();
        tree.updateDomFocus();
      }
    },
    [tree, startRename, openDelete],
  );

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent, fileId: string) => {
      const entry = entriesById.get(fileId);
      if (!entry) return;

      event.preventDefault();

      const items =
        entry.kind === "directory"
          ? [
              { id: "new-drawing", label: "New drawing" },
              { id: "new-folder", label: "New folder" },
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete" },
            ]
          : [
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete" },
            ];

      const id = await window.api.contextMenu.show(items, event.clientX, event.clientY);

      switch (id) {
        case "new-drawing":
          void handleCreate(fileId, "file");
          break;
        case "new-folder":
          void handleCreate(fileId, "directory");
          break;
        case "rename":
          startRename(fileId);
          break;
        case "delete": {
          const name = entry ? stripExcalidraw(entry.name) : fileId;
          openDelete(fileId, name, "trash");
          break;
        }
      }
    },
    [entriesById, startRename, openDelete, handleCreate],
  );

  const handleRename = useCallback(
    async (fileId: string, newName: string) => {
      const isFresh = freshDrawingIdRef.current === fileId;
      const entry = entriesById.get(fileId);
      const changed = entry ? newName !== stripExcalidraw(entry.name) : true;

      try {
        if (changed) {
          const ok = await renameEntry(fileId, newName);
          if (!ok) {
            setRenameError(null);
            setRenamingId(null);
            return;
          }

          toast.add({ title: "Drawing renamed", type: "success" });
        }

        setRenameError(null);
        setRenamingId(null);

        if (isFresh) {
          clearFreshMarker(fileId);
          await setOpenFileId(fileId);
        }
      } catch (error) {
        setRenameError(toAppError(error, "rename", false));
      }
    },
    [renameEntry, clearFreshMarker, setOpenFileId, entriesById],
  );

  return (
    <>
      <Sidebar side="left">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center justify-between">
              Drawings
              <button
                type="button"
                aria-label="New drawing or folder"
                title="New drawing or folder"
                className="text-muted-foreground hover:text-foreground -mr-1 rounded p-0.5 transition-colors"
                onClick={(e) => void openRootMenu(e.clientX, e.clientY)}
              >
                <PlusIcon className="size-3.5" />
              </button>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {entries.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-xs leading-relaxed">
                  No drawings yet. Use + to create your first one.
                </p>
              ) : (
                <TreeContainer
                  tree={tree}
                  onKeyDown={handleContainerKeyDown}
                  onContextMenu={(e) => {
                    if (e.target === e.currentTarget) void openRootMenu(e.clientX, e.clientY);
                  }}
                >
                  {tree.getItems().map((item) => {
                    const entry = item.getItemData();
                    if (!entry || !entry.name) return null;

                    return (
                      <Fragment key={item.getKey()}>
                        {renamingId === entry.id ? (
                          <div
                            style={{
                              paddingLeft: `${item.getItemMeta().level * 16 + 16 + 6 - 11}px`,
                            }}
                            className="pr-2"
                          >
                            <RenameInput
                              initial={stripExcalidraw(entry.name)}
                              error={renameError}
                              treatUnchangedAsCommit={freshDrawingIdRef.current === entry.id}
                              onCommit={(v) => handleRename(entry.id, v)}
                              onCancel={() => {
                                clearFreshMarker(entry.id);
                                setRenameError(null);
                                setRenamingId(null);
                              }}
                            />
                          </div>
                        ) : (
                          <TreeRow
                            item={item}
                            label={stripExcalidraw(entry.name)}
                            isActive={entry.id === openFileId}
                            isDirty={dirtyById[entry.id] !== undefined}
                            onContextMenu={(e) => handleContextMenu(e, entry.id)}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </TreeContainer>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenSettings}>
                <SettingsIcon />
                Settings
                <KbdGroup className="ml-auto group-data-[collapsible=icon]:hidden">
                  {formatForDisplay("Mod+,")
                    .split(" ")
                    .map((token) => (
                      <Kbd key={token}>{token}</Kbd>
                    ))}
                </KbdGroup>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.mode === "permanent"
                ? `Permanently delete "${deleteTarget?.name}"?`
                : `Delete "${deleteTarget?.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.mode === "permanent"
                ? "This cannot be undone."
                : "The item will be moved to the system trash. You can restore it later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDeleteConfirm()}>
              {deleteTarget?.mode === "permanent" ? "Delete Forever" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const RenameInput = ({
  initial,
  error,
  treatUnchangedAsCommit = false,
  onCommit,
  onCancel,
}: {
  initial: string;
  error: AppError | null;
  treatUnchangedAsCommit?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const lastCommitted = useRef<string | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    if (!error) return;
    finished.current = false;
    ref.current?.focus();
  }, [error]);

  const finish = useCallback(
    (action: "commit" | "cancel") => {
      if (finished.current) return;
      finished.current = true;
      if (action === "commit") {
        const trimmed = value.trim();
        if (!trimmed || (trimmed === initial && !treatUnchangedAsCommit)) {
          onCancel();
        } else {
          lastCommitted.current = trimmed;
          onCommit(trimmed);
        }
      } else {
        onCancel();
      }
    },
    [value, initial, onCommit, onCancel, treatUnchangedAsCommit],
  );

  return (
    <Field data-invalid={error ? "true" : undefined} className="gap-1">
      <Input
        ref={ref}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish("commit");
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish("cancel");
          }
        }}
        onBlur={() => {
          if (error && value.trim() === lastCommitted.current) finish("cancel");
          else finish("commit");
        }}
        className="h-8 text-xs"
      />
      <FieldError errors={error ? [{ message: error.message }] : undefined} className="text-xs" />
    </Field>
  );
};
