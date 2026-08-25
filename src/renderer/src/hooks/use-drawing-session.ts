import { useEffect, useRef, type RefObject } from "react";

import { toast } from "@/components/ui/toast";
import { saveErrorToastId } from "@/lib/app-error";
import { createDrawingSession, type SaveOrigin } from "@/lib/drawing-session";
import { type BoundDrawingSession, sessionOwner } from "@/lib/session-owner";

export const useDrawingSession = (
  fileId: string,
  save: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>,
  onDirtyChange: (id: string, dirty: boolean) => void,
  sessionRef: RefObject<BoundDrawingSession | null>,
) => {
  const live = useRef<BoundDrawingSession | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    const activeFileId = sessionOwner.getActiveFileId();

    if (!live.current || !activeFileId) {
      const session = sessionOwner.acquire(
        fileId,
        createDrawingSession({
          fileId,
          save,
          onDirtyChange,
          onSaveGaveUp: (failedFileId) => {
            toast.add({
              id: saveErrorToastId(failedFileId),
              title: "Autosave stopped",
              description: "Couldn't save after several attempts. Press Ctrl+S to retry.",
              type: "error",
              timeout: 0,
            });
          },
        }),
      );
      live.current = session;
      sessionRef.current = session;
      return;
    }

    if (activeFileId !== fileId) {
      sessionOwner.retargetActive(activeFileId, fileId);
      sessionRef.current = live.current;
    }
  }, [fileId, save, onDirtyChange, sessionRef]);

  useEffect(() => {
    const flushOnEdge = () => {
      void live.current?.flush();
    };

    window.addEventListener("blur", flushOnEdge);
    document.addEventListener("visibilitychange", flushOnEdge);
    window.addEventListener("beforeunload", flushOnEdge);

    return () => {
      window.removeEventListener("blur", flushOnEdge);
      document.removeEventListener("visibilitychange", flushOnEdge);
      window.removeEventListener("beforeunload", flushOnEdge);
    };
  }, []);

  useEffect(
    () => () => {
      const releasedFileId = sessionOwner.getActiveFileId();
      sessionOwner.releaseActive();
      live.current = null;
      sessionRef.current = null;
      if (releasedFileId) onDirtyChangeRef.current(releasedFileId, false);
    },
    [sessionRef],
  );
};
