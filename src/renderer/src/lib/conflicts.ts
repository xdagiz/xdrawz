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
) => {
  if (conflict?.fileId === fileId) return true;
  if (dismissedKey === `missing:${fileId}`) return true;
  if (typeof dismissedKey === "string" && dismissedKey.startsWith("changed:")) {
    const rest = dismissedKey.slice("changed:".length);
    const idx = rest.lastIndexOf(":");
    if (idx === -1) return false;
    return rest.slice(0, idx) === fileId;
  }
  return false;
};

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
  rawDirtyById: Record<string, true>;
  externalConflict: ExternalConflict;
  editorGeneration: number;
};

export type EntryReduction = EntryReductionState;

const isStillPresent = (entries: FileEntry[], fileId: string | null) =>
  entries.some((e) => e.id === fileId && e.kind === "file");

const findOnDisk = (entries: FileEntry[], fileId: string) => entries.find((e) => e.id === fileId);

const isStale = (oldEntry: FileEntry, newEntry: FileEntry) =>
  newEntry.modifiedAt > oldEntry.modifiedAt || newEntry.size !== oldEntry.size;

export const reduceEntries = (
  state: EntryReductionState,
  event: FilesChangedEvent,
  openFileDirty: boolean,
): EntryReduction => {
  const entries = event.entries;
  const { openFileId } = state;
  const dirtyById = state.dirtyById;
  const prevConflict = state.externalConflict;

  let externalConflict: ExternalConflict = null;
  let nextOpenFileId = openFileId;
  let nextEditorGeneration = state.editorGeneration;

  if (openFileId) {
    const stillExists = isStillPresent(entries, openFileId);

    if (!stillExists && openFileDirty) {
      externalConflict = { type: "missing", fileId: openFileId };
    } else if (stillExists && openFileDirty) {
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
      } else if (oldEntry && newEntry && isStale(oldEntry, newEntry)) {
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
    } else if (stillExists && !openFileDirty) {
      const oldEntry = findOnDisk(state.entries, openFileId);
      const newEntry = findOnDisk(entries, openFileId);
      if (oldEntry && newEntry && isStale(oldEntry, newEntry)) {
        nextEditorGeneration = state.editorGeneration + 1;
      }
    }

    if (!stillExists && !openFileDirty) nextOpenFileId = null;
  }

  const nextDirty = { ...dirtyById };
  for (const id of Object.keys(nextDirty)) {
    if (id === openFileId && externalConflict?.type === "missing") continue;
    if (!entries.some((e) => e.id === id)) delete nextDirty[id];
  }

  const nextRawDirty = { ...state.rawDirtyById };
  for (const id of Object.keys(nextRawDirty)) {
    if (id === openFileId && externalConflict?.type === "missing") continue;
    if (!entries.some((e) => e.id === id)) delete nextRawDirty[id];
  }

  return {
    entries,
    openFileId: nextOpenFileId,
    dirtyById: nextDirty,
    rawDirtyById: nextRawDirty,
    externalConflict,
    editorGeneration: nextEditorGeneration,
  };
};
