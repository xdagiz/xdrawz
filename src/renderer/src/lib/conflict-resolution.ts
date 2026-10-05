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
} from "@/lib/conflicts";
import type { SaveOrigin } from "@/lib/drawing-session";
import { sessionOwner } from "@/lib/session-owner";

export type ConflictSlice = {
  rootPath: string | null;
  editorGeneration: number;
  entries: FileEntry[];
  openFileId: string | null;
  dirtyById: Record<string, true>;
  rawDirtyById: Record<string, true>;
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

  let recoveryEpoch = 0;

  const captureRecovery = (conflict: NonNullable<ExternalConflict>) => {
    const state = get();
    const session = sessionOwner.getSession(conflict.fileId);
    const lifetime = session?.getLifetime();
    const epoch = ++recoveryEpoch;
    return {
      session,
      rootIntact: () => get().rootPath === state.rootPath,
      isCurrent: () => {
        const current = get();
        return (
          epoch === recoveryEpoch &&
          current.externalConflict === conflict &&
          current.rootPath === state.rootPath &&
          current.editorGeneration === state.editorGeneration &&
          current.openFileId === conflict.fileId &&
          sessionOwner.getSession(conflict.fileId) === session &&
          session?.getLifetime() === lifetime
        );
      },
    };
  };

  const performRecover = async (
    fileId: string,
    body: string,
    recovery: ReturnType<typeof captureRecovery>,
    acknowledge?: () => boolean,
  ) => {
    if (!recovery.isCurrent()) return false;
    try {
      const entry = await window.api.files.writeRecover(fileId, body);
      if (recovery.rootIntact()) {
        set({
          entries: deps.commitEntries([...get().entries.filter((e) => e.id !== entry.id), entry]),
        });
      }
      if (!recovery.isCurrent()) return false;
      set({ error: null, externalConflict: null });
      acknowledge?.();
      return true;
    } catch (err) {
      if (recovery.isCurrent()) set({ error: toAppError(err, "recover") });
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
      const recovery = captureRecovery(conflict);
      const choice = await window.api.dialog.fileRecover(fileName);

      const current = get().externalConflict;
      if (
        !recovery.isCurrent() ||
        !current ||
        current.type !== "missing" ||
        conflictKeyOf(current) !== expectedKey
      ) {
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

      const snapshot = recoverContent === undefined ? recovery.session?.capturePersistence() : null;
      const body = recoverContent ?? snapshot?.content;

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
      const ok = await performRecover(current.fileId, body, recovery, snapshot?.acknowledge);
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

    const recovery = captureRecovery(conflict);
    const snapshot = recovery.session?.capturePersistence();
    const body = snapshot?.content;
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

    return performRecover(conflict.fileId, body, recovery, snapshot?.acknowledge);
  };

  const resetConflicts = () => {
    recoveryEpoch += 1;
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
