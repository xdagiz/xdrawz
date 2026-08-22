import type { SaveOrigin } from "@shared/ipc";
import { useEffect, useRef, type RefObject } from "react";

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
      createDrawingSession({ fileId, save, onDirtyChange }),
    );
    live.current = session;
    sessionRef.current = session;

    return () => {
      sessionOwner.release(fileId);
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
