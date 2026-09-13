import { codedError } from "@shared/errors";
import type { FileEntry } from "@shared/ipc";

import { toAppError, type AppError } from "@/lib/app-error";
import { isCloseHandshakeActive } from "@/lib/close-handshake";
import {
  conflictBelongsTo,
  conflictKeyOf,
  createSingleFlight,
  type ExternalConflict,
  fileNameOf,
  removeKey,
} from "@/lib/conflicts";
import type { SaveOrigin } from "@/lib/drawing-session";
import { sessionOwner } from "@/lib/session-owner";

export type ConflictSlice = {
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  error: AppError | null;
  externalConflict: ExternalConflict;
};

type ResolverDeps = {
  get: () => ConflictSlice;
  set: (patch: Partial<ConflictSlice>) => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
  commitEntries: (entries: FileEntry[]) => FileEntry[];
};

export type SaveGate = { action: "proceed" } | { action: "stop"; result: boolean };

export const createConflictResolver = (deps: ResolverDeps) => {
  const { get, set } = deps;
  const runChangedDialog = createSingleFlight<"reload" | "overwrite" | "cancel">();
  const runRecoverDialog = createSingleFlight<"recover" | "discard" | "cancel">();
  let dismissedKey: string | null = null;

  const performRecover = async (fileId: string, body: string) => {
    try {
      await window.api.files.writeRecover(fileId, body);
      const entries = await window.api.files.list();
      sessionOwner.getSession(fileId)?.markPersisted();
      set({
        error: null,
        externalConflict: null,
        entries: deps.commitEntries(entries),
        dirtyById: removeKey(get().dirtyById, fileId),
      });
      return true;
    } catch (err) {
      set({ error: toAppError(err, "recover") });
      return false;
    }
  };

  const resolveChangedConflict = async (opts?: { force?: boolean }) => {
    const force = opts?.force === true;
    const state = get();
    const conflict = state.externalConflict;
    if (!conflict || conflict.type !== "changed") return "cancel";

    const key = conflictKeyOf(conflict);
    if (!force && dismissedKey === key) return "cancel";

    const fileName = fileNameOf(state.entries, conflict.fileId);
    const expectedKey = key;

    return runChangedDialog(async () => {
      const choice = await window.api.dialog.fileChanged(fileName);

      const current = get().externalConflict;
      if (!current || current.type !== "changed" || conflictKeyOf(current) !== expectedKey) {
        return "cancel" as const;
      }

      if (choice === "reload") {
        dismissedKey = null;
        deps.reloadOpenFileFromDisk();
      } else if (choice === "overwrite") {
        dismissedKey = null;
        set({ externalConflict: null });
      } else {
        dismissedKey = conflictKeyOf(current);
      }

      return choice;
    });
  };

  const resolveMissingConflict = async (
    content?: string,
    opts?: { force?: boolean },
  ): Promise<"recover" | "discard" | "cancel"> => {
    const force = opts?.force === true;
    const state = get();
    const conflict = state.externalConflict;
    if (!conflict || conflict.type !== "missing") return "cancel";

    const key = conflictKeyOf(conflict);
    if (!force && dismissedKey === key) return "cancel";

    const fileName = fileNameOf(state.entries, conflict.fileId);
    const expectedKey = key;
    const recoverContent = content;

    return runRecoverDialog(async () => {
      const choice = await window.api.dialog.fileRecover(fileName);

      const current = get().externalConflict;
      if (!current || current.type !== "missing" || conflictKeyOf(current) !== expectedKey) {
        return "cancel" as const;
      }

      if (choice === "cancel") {
        dismissedKey = conflictKeyOf(current);
        return "cancel";
      }

      if (choice === "discard") {
        dismissedKey = null;
        deps.discardMissingOpenFile();
        return "discard";
      }

      const body = recoverContent ?? sessionOwner.getSession()?.getSerializedContent() ?? null;

      if (!body) {
        set({
          error: toAppError(
            codedError("Nothing to recover", {
              code: "INVALID",
              reason: "invalid-arg",
              field: "content",
            }),
            "recover",
          ),
        });
        return "cancel";
      }

      dismissedKey = null;
      const ok = await performRecover(current.fileId, body);
      return ok ? ("recover" as const) : ("cancel" as const);
    });
  };

  const gateConflictedSave = async (
    id: string,
    content: string,
    origin: SaveOrigin,
  ): Promise<SaveGate> => {
    const conflict = get().externalConflict;
    if (!conflict || conflict.fileId !== id) return { action: "proceed" };
    if (origin !== "explicit") return { action: "stop", result: false };

    if (isCloseHandshakeActive()) {
      dismissedKey = null;
      return { action: "stop", result: false };
    }

    if (conflict.type === "changed") {
      const choice = await resolveChangedConflict({ force: true });
      return choice === "overwrite" ? { action: "proceed" } : { action: "stop", result: false };
    }

    if (conflict.type === "missing") {
      const choice = await resolveMissingConflict(content, { force: true });
      return { action: "stop", result: choice !== "cancel" };
    }

    return { action: "proceed" };
  };

  const recoverMissingOpenFile = async () => {
    const conflict = get().externalConflict;
    if (!conflict || conflict.type !== "missing") return false;

    const body = sessionOwner.getSession()?.getSerializedContent();
    if (!body) {
      set({
        error: toAppError(
          codedError("Nothing to recover", {
            code: "INVALID",
            reason: "invalid-arg",
            field: "content",
          }),
          "recover",
        ),
      });
      return false;
    }

    return performRecover(conflict.fileId, body);
  };

  const resetConflicts = () => {
    dismissedKey = null;
    set({ externalConflict: null });
  };

  const syncDismissal = (next: ExternalConflict) => {
    const nextKey = next ? conflictKeyOf(next) : null;
    if (nextKey !== dismissedKey) dismissedKey = null;
  };

  const clearDismissalIfOwned = (fileId: string) => {
    const owns = conflictBelongsTo(get().externalConflict, dismissedKey, fileId);
    if (owns) dismissedKey = null;
    return owns;
  };

  return {
    gateConflictedSave,
    recoverMissingOpenFile,
    resolveChangedConflict,
    resolveMissingConflict,
    resetConflicts,
    clearDismissalIfOwned,
    syncDismissal,
  };
};
