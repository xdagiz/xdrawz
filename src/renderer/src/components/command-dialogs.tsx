import { useState } from "react";

import { toAppError } from "@/lib/app-error";
import { fileNameOf } from "@/lib/conflicts";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { toast } from "./ui/toast";

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const CommandRenameDialog = ({ open, onOpenChange }: DialogProps) => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const renameEntry = useStore((s) => s.renameEntry);
  const [value, setValue] = useState(() =>
    openFileId ? stripExcalidraw(fileNameOf(entries, openFileId)) : "",
  );
  const [committing, setCommitting] = useState(false);

  const commit = async () => {
    if (!openFileId || committing || value.trim().length === 0) return;
    setCommitting(true);
    try {
      const ok = await renameEntry(openFileId, value.trim());
      if (ok) toast.add({ title: "Drawing renamed", type: "success" });
      onOpenChange(false);
    } catch (error) {
      toast.add({ title: toAppError(error, "rename").detail, type: "error" });
    } finally {
      setCommitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename drawing</DialogTitle>
        </DialogHeader>
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
};

export const CommandDeleteDialog = ({ open, onOpenChange }: DialogProps) => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const deleteEntry = useStore((s) => s.deleteEntry);
  const [deleting, setDeleting] = useState(false);

  const name = openFileId ? stripExcalidraw(fileNameOf(entries, openFileId)) : "";

  const confirm = async () => {
    if (!openFileId || deleting) return;
    setDeleting(true);
    try {
      const ok = await deleteEntry(openFileId, "trash");
      if (ok) toast.add({ title: `Deleted ${name}`, type: "success" });
    } catch (error) {
      toast.add({ title: toAppError(error, "delete").detail, type: "error" });
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete "${name}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            The item will be moved to the system trash. You can restore it later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void confirm()}>
            Move to Trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
