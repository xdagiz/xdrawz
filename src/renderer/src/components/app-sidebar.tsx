import { SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { toAppError, type AppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { toast } from "./ui/toast";

export const AppSidebar = ({ onOpenSettings }: { onOpenSettings: () => void }) => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const renameFile = useStore((s) => s.renameFile);
  const deleteFile = useStore((s) => s.deleteFile);
  const files = entries.filter((entry) => entry.kind === "file");

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<AppError | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;

    try {
      const ok = await deleteFile(deleteTarget.id);
      if (ok) toast.add({ title: `Deleted ${deleteTarget.name}`, type: "success" });
    } catch (error) {
      toast.add({ title: toAppError(error, "delete").message, type: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteFile]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent, fileId: string) => {
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
          setRenameError(null);
          setRenamingId(fileId);
          break;
        case "delete": {
          const entry = entries.find((e) => e.id === fileId);
          const name = entry ? stripExcalidraw(entry.name) : fileId;
          setDeleteTarget({ id: fileId, name });
          break;
        }
      }
    },
    [entries],
  );

  const handleRename = useCallback(
    async (fileId: string, newName: string) => {
      try {
        const ok = await renameFile(fileId, newName);
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
    [renameFile],
  );

  const openDrawing = useCallback(
    async (fileId: string) => {
      if (fileId !== useStore.getState().openFileId) {
        await setOpenFileId(fileId);
        if (useStore.getState().openFileId !== fileId) return;
      }
    },
    [setOpenFileId],
  );

  return (
    <>
      <Sidebar side="left">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Drawings</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {files.map((file) => {
                  const isDirty = dirtyById[file.id] !== undefined;

                  return (
                    <SidebarMenuItem key={file.id}>
                      {renamingId === file.id ? (
                        <RenameInput
                          initial={stripExcalidraw(file.name)}
                          error={renameError}
                          onCommit={(v) => handleRename(file.id, v)}
                          onCancel={() => {
                            setRenameError(null);
                            setRenamingId(null);
                          }}
                        />
                      ) : (
                        <SidebarMenuButton
                          isActive={file.id === openFileId}
                          tooltip={file.id}
                          onClick={() => void openDrawing(file.id)}
                          onContextMenu={(e) => handleContextMenu(e, file.id)}
                          data-dirty={isDirty ? "true" : undefined}
                          className={`relative pr-6 ${isDirty ? "dirty-dot" : ""}`}
                        >
                          <span className="truncate">{stripExcalidraw(file.name)}</span>
                          {isDirty && <span className="sr-only">(unsaved changes)</span>}
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  );
                })}

                {files.length === 0 && (
                  <p className="text-muted-foreground px-2 py-1.5 text-xs leading-relaxed">
                    Drawings are .excalidraw files inside your drawings folder.
                  </p>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onOpenSettings}>
              <SettingsIcon />
              Settings
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarFooter>
      </Sidebar>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleDeleteConfirm()}>
              Delete
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
        if (trimmed) {
          lastCommitted.current = trimmed;
          onCommit(trimmed);
        } else {
          onCancel();
        }
      } else {
        onCancel();
      }
    },
    [value, onCommit, onCancel],
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
