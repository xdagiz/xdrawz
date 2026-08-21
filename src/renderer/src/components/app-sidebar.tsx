import type { FileDeleteMode } from "@shared/ipc";
import { isAncestorId } from "@shared/ipc";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { SettingsIcon } from "lucide-react";
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
import { ancestorIdsOf, buildEntriesById, buildSortedChildIndex } from "@/lib/tree";
import { stripExcalidraw } from "@/lib/utils";

import { toast } from "./ui/toast";

export const AppSidebar = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const renameEntry = useStore((s) => s.renameEntry);
  const deleteEntry = useStore((s) => s.deleteEntry);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<AppError | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    mode: FileDeleteMode;
  } | null>(null);

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

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;

    try {
      const ok = await deleteEntry(deleteTarget.id, deleteTarget.mode);
      if (ok) toast.add({ title: `Deleted ${deleteTarget.name}`, type: "success" });
    } catch (error) {
      toast.add({ title: toAppError(error, "delete").message, type: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteEntry]);

  const startRename = useCallback((fileId: string) => {
    setRenameError(null);
    setRenamingId(fileId);
  }, []);

  const openDelete = useCallback((id: string, name: string, mode: FileDeleteMode) => {
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

    setDeleteTarget({ id, name, mode });
  }, []);

  const handleContainerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;

      const focusedItem = tree.getItems().find((item) => item.isFocused());
      if (!focusedItem) return;

      const entry = focusedItem.getItemData();
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
      }
    },
    [tree, startRename, openDelete],
  );

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent, fileId: string) => {
      const entry = entriesById.get(fileId);
      if (!entry) return;

      event.preventDefault();

      const id = await window.api.contextMenu.show(
        [
          { id: "rename", label: "Rename" },
          { id: "delete", label: "Delete" },
        ],
        event.clientX,
        event.clientY,
      );

      switch (id) {
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
    [entriesById, startRename, openDelete],
  );

  const handleRename = useCallback(
    async (fileId: string, newName: string) => {
      try {
        const ok = await renameEntry(fileId, newName);
        if (!ok) {
          setRenameError(null);
          setRenamingId(null);
          return;
        }

        toast.add({ title: "Drawing renamed", type: "success" });
        setRenameError(null);
        setRenamingId(null);
      } catch (error) {
        setRenameError(toAppError(error, "rename", false));
      }
    },
    [renameEntry],
  );

  return (
    <>
      <Sidebar side="left">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Drawings</SidebarGroupLabel>
            <SidebarGroupContent>
              {entries.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-xs leading-relaxed">
                  Drawings are .excalidraw files inside your drawings folder. Create folders in your
                  file manager to organize them.
                </p>
              ) : (
                <TreeContainer tree={tree} onKeyDown={handleContainerKeyDown}>
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
                              onCommit={(v) => handleRename(entry.id, v)}
                              onCancel={() => {
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
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
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
  onCommit,
  onCancel,
}: {
  initial: string;
  error: AppError | null;
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
        if (!trimmed || trimmed === initial) {
          onCancel();
        } else {
          lastCommitted.current = trimmed;
          onCommit(trimmed);
        }
      } else {
        onCancel();
      }
    },
    [value, initial, onCommit, onCancel],
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
