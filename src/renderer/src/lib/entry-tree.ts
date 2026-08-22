import type { FileEntry } from "@shared/ipc";
import { isAncestorId } from "@shared/ipc";

export const remapId = (id: string, oldRoot: string, newRoot: string): string => {
  if (id === oldRoot) return newRoot;
  if (isAncestorId(oldRoot, id)) return `${newRoot}${id.slice(oldRoot.length)}`;
  return id;
};

export const remapNullableId = (
  id: string | null | undefined,
  oldRoot: string,
  newRoot: string,
): string | null => (id ? remapId(id, oldRoot, newRoot) : null);

export const isInsideSubtree = (root: string, id: string | null | undefined): id is string => {
  if (!id) return false;
  return id === root || isAncestorId(root, id);
};

export type EntryTreeState = {
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
};

export type SubtreeDeleteResult = {
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  openedRemoved: boolean;
};

export const applySubtreeDelete = (state: EntryTreeState, root: string): SubtreeDeleteResult => {
  const entries = state.entries.filter((e) => !isInsideSubtree(root, e.id));

  const dirtyById: Record<string, true> = {};
  for (const key of Object.keys(state.dirtyById)) {
    if (!isInsideSubtree(root, key)) dirtyById[key] = true;
  }

  const openedRemoved = isInsideSubtree(root, state.openFileId);

  return {
    entries,
    openFileId: openedRemoved ? null : state.openFileId,
    dirtyById,
    openedRemoved,
  };
};
