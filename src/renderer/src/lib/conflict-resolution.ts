import type { ExternalConflict, FileEntry, SaveOrigin } from "@shared/ipc";

import { toAppError, type AppError } from "@/lib/app-error";
import { isCloseHandshakeActive } from "@/lib/close-handshake";
import { conflictKeyOf, createSingleFlight, fileNameOf, removeKey } from "@/lib/conflicts";
import { sessionOwner } from "@/lib/session-owner";
import type { State } from "@/lib/store";

const runChangedDialog = createSingleFlight<"reload" | "overwrite" | "cancel">();
const runRecoverDialog = createSingleFlight<"recover" | "discard" | "cancel">();
let pendingRecoverContent: string | undefined;

type ResolverDeps = {
  get: () => Pick<
    State,
    "entries" | "openFileId" | "dirtyById" | "externalConflict" | "dismissedConflictKey"
  >;
  set: (
    patch: Partial<{
      entries: FileEntry[];
      dirtyById: Record<string, true>;
      error: AppError | null;
      externalConflict: ExternalConflict;
      dismissedConflictKey: string | null;
    }>,
  ) => void;
  reloadOpenFileFromDisk: () => void;
  discardMissingOpenFile: () => void;
};

export type SaveGate = { action: "proceed" } | { action: "stop"; result: boolean };

export const createConflictResolver = (deps: ResolverDeps) => {
  const { get, set } = deps;

  const performRecover = async (fileId: string, body: string) => {
    try {
      await window.api.files.writeRecover(fileId, body);
      const entries = await window.api.files.list();
      set({
        error: null,
        externalConflict: null,
        entries,
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
    if (!force && state.dismissedConflictKey === key) return "cancel";

    const fileName = fileNameOf(state.entries, conflict.fileId);
    const expectedFileId = conflict.fileId;

    return runChangedDialog(async () => {
      const choice = await window.api.dialog.fileChanged(fileName);

      const current = get().externalConflict;
      if (!current || current.type !== "changed" || current.fileId !== expectedFileId) {
        return "cancel" as const;
      }

      if (choice === "reload") {
        set({ dismissedConflictKey: null });
        deps.reloadOpenFileFromDisk();
      } else if (choice === "overwrite") {
        set({ externalConflict: null, dismissedConflictKey: null });
      } else {
        set({ dismissedConflictKey: conflictKeyOf(current) });
      }

      return choice;
    });
  };

  const resolveMissingConflict = async (
    content?: string,
    opts?: { force?: boolean },
  ): Promise<"recover" | "discard" | "cancel"> => {
    if (content !== undefined) pendingRecoverContent = content;

    const force = opts?.force === true;
    const state = get();
    const conflict = state.externalConflict;
    if (!conflict || conflict.type !== "missing") return "cancel";

    const key = conflictKeyOf(conflict);
    if (!force && state.dismissedConflictKey === key) return "cancel";

    const fileName = fileNameOf(state.entries, conflict.fileId);
    const expectedFileId = conflict.fileId;

    return runRecoverDialog(async () => {
      try {
        const choice = await window.api.dialog.fileRecover(fileName);

        const current = get().externalConflict;
        if (!current || current.type !== "missing" || current.fileId !== expectedFileId) {
          return "cancel" as const;
        }

        if (choice === "cancel") {
          set({ dismissedConflictKey: conflictKeyOf(current) });
          return "cancel";
        }

        if (choice === "discard") {
          set({ dismissedConflictKey: null });
          deps.discardMissingOpenFile();
          return "discard";
        }

        const body =
          pendingRecoverContent ?? sessionOwner.getSession()?.getSerializedContent() ?? null;

        if (!body) {
          set({ error: toAppError(new Error("Nothing to recover"), "recover", false) });
          return "cancel";
        }

        set({ dismissedConflictKey: null });
        const ok = await performRecover(expectedFileId, body);
        return ok ? ("recover" as const) : ("cancel" as const);
      } finally {
        pendingRecoverContent = undefined;
      }
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
      set({ dismissedConflictKey: null });
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

  return {
    gateConflictedSave,
    resolveChangedConflict,
    resolveMissingConflict,
  };
};
