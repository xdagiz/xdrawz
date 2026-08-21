import { Excalidraw, restoreAppState, restoreElements } from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useHotkey } from "@tanstack/react-hotkeys";
import { PanelLeftIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTheme } from "@/hooks/use-theme";
import { toAppError, type AppError } from "@/lib/app-error";
import {
  createDrawingSession,
  drawingSignature,
  type DrawingSessionControls,
} from "@/lib/drawing-session";
import { useStore } from "@/lib/store";

import { ErrorBoundary } from "./error-boundary";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { useSidebar } from "./ui/sidebar";

type DrawingData = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState> | null;
  files?: ExcalidrawInitialDataState["files"];
};

type LoadedDrawing = {
  drawing: ExcalidrawInitialDataState | null;
  baseline: string | null;
};

const loadDrawing = async (fileId: string): Promise<LoadedDrawing> => {
  const content = await window.api.files.read(fileId);
  const parsed: DrawingData = JSON.parse(content);
  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const files = parsed.files ?? undefined;

  const appState = restoreAppState(parsed.appState ?? null, null);
  const elements = restoreElements(rawElements, null, {
    repairBindings: true,
  });

  return {
    drawing: { elements, appState, files },
    baseline: drawingSignature(elements, appState, files),
  };
};

type Props = {
  fileId: string;
};

export const ExcalidrawEditor = ({ fileId }: Props) => {
  const theme = useTheme();
  const saveFile = useStore((s) => s.saveFile);
  const setFileDirty = useStore((s) => s.setFileDirty);
  const registerSession = useStore((s) => s.registerSession);
  const unregisterSession = useStore((s) => s.unregisterSession);
  const { toggleSidebar } = useSidebar();

  const sessionRef = useRef<DrawingSessionControls | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const initialData = useMemo(() => {
    return async () => {
      try {
        const loaded = await loadDrawing(fileId);
        sessionRef.current?.setInitialBaseline(loaded.baseline);
        return loaded.drawing;
      } catch (error) {
        console.error("Failed to load drawing:", error);
        sessionRef.current?.resetBaseline();
        setLoadError(toAppError(error, "read"));
        return null;
      }
    };
  }, [fileId]);

  useEffect(() => {
    const session = createDrawingSession({
      fileId,
      save: saveFile,
      onDirtyChange: setFileDirty,
    });

    sessionRef.current = session;
    registerSession(session);

    return () => {
      session.dispose();
      unregisterSession(session);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [fileId, saveFile, setFileDirty, registerSession, unregisterSession]);

  useEffect(() => {
    const flushOnEdge = () => {
      void sessionRef.current?.flush();
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

  useHotkey("Mod+S", () => {
    void sessionRef.current?.saveNow();
  });

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      sessionRef.current?.onChange(elements, appState, files);
    },
    [],
  );

  useEffect(() => {
    const root = editorRef.current;

    let anchor: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    const sync = () => {
      const canvasActions = root?.querySelector<HTMLElement>(".App-menu_top__left > :first-child");
      if (!canvasActions) return;

      let host = canvasActions.querySelector<HTMLElement>(":scope > [data-xdrawz-sidebar-anchor]");
      if (!host) {
        host = document.createElement("div");
        host.dataset.xdrawzSidebarAnchor = "";
        host.style.position = "absolute";
        host.style.top = "0";
        host.style.left = "0";
        host.style.pointerEvents = "auto";
        canvasActions.prepend(host);
      }

      const reserved = "calc(var(--lg-button-size, 2.25rem) + 0.5rem)";
      if (canvasActions.style.paddingLeft !== reserved) {
        canvasActions.style.paddingLeft = reserved;
      }

      if (anchor !== host) {
        anchor = host;
        setMenuAnchor(host);
      }
    };

    if (root) {
      sync();
      observer = new MutationObserver(sync);
      observer.observe(root, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      if (anchor) {
        anchor.parentElement?.style.removeProperty("padding-left");
        anchor.remove();
      }
    };
  }, []);

  if (loadError) {
    return (
      <>
        <Empty className="bg-background h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon className="text-destructive" />
            </EmptyMedia>
            <EmptyTitle>{loadError.title}</EmptyTitle>
            <EmptyDescription>{loadError.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button
              onClick={() => {
                setLoadError(null);
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              <RefreshCwIcon />
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      </>
    );
  }

  return (
    <div ref={editorRef} className="relative h-full min-h-0 w-full overflow-hidden">
      <ErrorBoundary
        title="The drawing editor stopped working"
        description="Try again. Your saved drawing is still available from the sidebar."
        resetKeys={[loadAttempt]}
      >
        <Excalidraw
          key={loadAttempt}
          theme={theme}
          initialData={initialData}
          onChange={handleChange}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
            },
          }}
        />
      </ErrorBoundary>
      {menuAnchor &&
        createPortal(
          <button
            type="button"
            className="sidebar-toggle"
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={toggleSidebar}
          >
            <PanelLeftIcon />
          </button>,
          menuAnchor,
        )}
    </div>
  );
};
