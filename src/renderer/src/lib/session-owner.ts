import type { UnsavedChoice, UnsavedReason } from "@shared/ipc";

import type { DrawingSessionControls } from "@/lib/drawing-session";

export type BoundDrawingSession = Omit<DrawingSessionControls, "ensureCleanOrConfirm"> & {
  ensureCleanOrConfirm: (reason: UnsavedReason) => Promise<boolean>;
};

export type SessionOwnerDeps = {
  confirmUnsaved: (reason: UnsavedReason) => Promise<UnsavedChoice>;
};

export type SessionOwner = {
  acquire: (fileId: string, session: DrawingSessionControls) => BoundDrawingSession;
  release: (fileId: string) => void;
  releaseActive: () => void;
  getSession: (fileId?: string) => BoundDrawingSession | null;
  getActiveFileId: () => string | null;
  retargetActive: (from: string, to: string) => void;
  setActiveForTest: (session: BoundDrawingSession | null) => void;
};

export const createSessionOwner = (deps: SessionOwnerDeps): SessionOwner => {
  let active: { fileId: string; session: BoundDrawingSession } | null = null;

  const bind = (session: DrawingSessionControls): BoundDrawingSession => ({
    ...session,
    ensureCleanOrConfirm: (reason) => session.ensureCleanOrConfirm(reason, deps.confirmUnsaved),
  });

  return {
    acquire: (fileId, session) => {
      if (active?.fileId === fileId) {
        session.dispose();
        return active.session;
      }
      active?.session.dispose();
      const bound = bind(session);
      active = { fileId, session: bound };
      return bound;
    },
    release: (fileId) => {
      if (!active || active.fileId !== fileId) return;
      active.session.dispose();
      active = null;
    },
    releaseActive: () => {
      if (!active) return;
      active.session.dispose();
      active = null;
    },
    getSession: (fileId) =>
      !active || (fileId !== undefined && active.fileId !== fileId) ? null : active.session,
    getActiveFileId: () => active?.fileId ?? null,
    retargetActive: (from, to) => {
      if (!active || active.fileId !== from) return;
      active.fileId = to;
      active.session.retarget(to);
    },
    setActiveForTest: (session) => {
      active = session ? { fileId: "", session } : null;
    },
  };
};

export const sessionOwner = createSessionOwner({
  confirmUnsaved: (reason) => window.api.dialog.unsavedChanges(reason),
});
