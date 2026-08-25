import type { FileEntry, FilesChangedEvent } from "@shared/ipc";

export type ConflictKey = string;

export type ExternalConflict =
  | { type: "missing"; fileId: string }
  | { type: "changed"; fileId: string; diskModifiedAt: number }
  | null;

export const removeKey = (obj: Record<string, true>, key: string): Record<string, true> => {
  const next = { ...obj };
  delete next[key];
  return next;
};

export const conflictKeyOf = (conflict: NonNullable<ExternalConflict>): ConflictKey =>
  conflict.type === "changed"
    ? `changed:${conflict.fileId}:${conflict.diskModifiedAt}`
    : `missing:${conflict.fileId}`;

export const conflictBelongsTo = (
  conflict: ExternalConflict,
  dismissedKey: string | null,
  fileId: string,
): boolean =>
  conflict?.fileId === fileId ||
  dismissedKey === `missing:${fileId}` ||
  (dismissedKey?.startsWith(`changed:${fileId}:`) ?? false);

export const fileNameOf = (entries: FileEntry[], id: string) => {
  const entry = entries.find((e) => e.id === id);
  return entry?.name ?? id.split("/").pop() ?? id;
};

export const createSingleFlight = <T>() => {
  let inflight: Promise<T> | null = null;

  return (task: () => Promise<T>): Promise<T> => {
    if (!inflight) {
      inflight = task().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
};

export type EntryReductionState = {
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  externalConflict: ExternalConflict;
  dismissedConflictKey: string | null;
  editorEpoch: number;
};

export type EntryReduction = EntryReductionState;

const isStillPresent = (entries: FileEntry[], fileId: string | null): boolean =>
  entries.some((e) => e.id === fileId && e.kind === "file");

const findOnDisk = (entries: FileEntry[], fileId: string) => entries.find((e) => e.id === fileId);

export const reduceEntries = (
  state: EntryReductionState,
  event: FilesChangedEvent,
): EntryReduction => {
  const entries = event.entries;
  const { openFileId } = state;
  const dirtyById = state.dirtyById;
  const prevConflict = state.externalConflict;

  let externalConflict: ExternalConflict = null;
  let nextOpenFileId = openFileId;
  let nextEditorEpoch = state.editorEpoch;

  if (openFileId) {
    const stillExists = isStillPresent(entries, openFileId);
    const isDirty = dirtyById[openFileId] !== undefined;

    if (!stillExists && isDirty) {
      externalConflict = { type: "missing", fileId: openFileId };
    } else if (stillExists && isDirty) {
      const oldEntry = findOnDisk(state.entries, openFileId);
      const newEntry = findOnDisk(entries, openFileId);

      if (
        prevConflict?.type === "changed" &&
        prevConflict.fileId === openFileId &&
        newEntry &&
        newEntry.modifiedAt >= prevConflict.diskModifiedAt
      ) {
        externalConflict = {
          type: "changed",
          fileId: openFileId,
          diskModifiedAt: Math.max(prevConflict.diskModifiedAt, newEntry.modifiedAt),
        };
      } else if (oldEntry && newEntry && newEntry.modifiedAt > oldEntry.modifiedAt) {
        externalConflict = {
          type: "changed",
          fileId: openFileId,
          diskModifiedAt: newEntry.modifiedAt,
        };
      } else if (
        prevConflict?.type === "missing" &&
        prevConflict.fileId === openFileId &&
        newEntry
      ) {
        externalConflict = {
          type: "changed",
          fileId: openFileId,
          diskModifiedAt: newEntry.modifiedAt,
        };
      }
    } else if (stillExists && !isDirty) {
      const oldEntry = findOnDisk(state.entries, openFileId);
      const newEntry = findOnDisk(entries, openFileId);
      if (oldEntry && newEntry && newEntry.modifiedAt > oldEntry.modifiedAt) {
        nextEditorEpoch = state.editorEpoch + 1;
      }
    }

    if (!stillExists && !isDirty) {
      nextOpenFileId = null;
    }
  }

  const nextDirty = { ...dirtyById };
  for (const id of Object.keys(nextDirty)) {
    if (id === openFileId && externalConflict?.type === "missing") continue;
    if (!entries.some((e) => e.id === id)) delete nextDirty[id];
  }

  const nextKey = externalConflict ? conflictKeyOf(externalConflict) : null;
  const dismissedConflictKey =
    nextKey && state.dismissedConflictKey === nextKey ? state.dismissedConflictKey : null;

  return {
    entries,
    openFileId: nextOpenFileId,
    dirtyById: nextDirty,
    externalConflict,
    editorEpoch: nextEditorEpoch,
    dismissedConflictKey,
  };
};
