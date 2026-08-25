import type { SaveOrigin } from "@shared/ipc";
import { useEffect, useRef, type RefObject } from "react";

import { toast } from "@/components/ui/toast";
import { saveErrorToastId } from "@/lib/app-error";
import { createDrawingSession } from "@/lib/drawing-session";
import { type BoundDrawingSession, sessionOwner } from "@/lib/session-owner";

export const useDrawingSession = (
  fileId: string,
  save: (id: string, content: string, origin?: SaveOrigin) => Promise<boolean>,
  onDirtyChange: (id: string, dirty: boolean) => void,
  sessionRef: RefObject<BoundDrawingSession | null>,
) => {
  const live = useRef<BoundDrawingSession | null>(null);

  useEffect(() => {
    const session = sessionOwner.acquire(
      fileId,
      createDrawingSession({
        fileId,
        save,
        onDirtyChange,
        onSaveGaveUp: () => {
          toast.add({
            id: saveErrorToastId(fileId),
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

    return () => {
      sessionOwner.release(fileId);
      onDirtyChange(fileId, false);
      if (live.current === session) live.current = null;
      if (sessionRef.current === session) sessionRef.current = null;
    };
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
};
