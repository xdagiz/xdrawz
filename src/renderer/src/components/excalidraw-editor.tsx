import {
  Excalidraw,
  restoreAppState,
  restoreElements,
  useHandleLibrary,
} from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useHotkey } from "@tanstack/react-hotkeys";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDrawingSession } from "@/hooks/use-drawing-session";
import { useTheme } from "@/hooks/use-theme";
import { toAppError, type AppError } from "@/lib/app-error";
import { drawingSignature } from "@/lib/drawing-session";
import { createLibraryPersistenceAdapter, defaultLibraryStorage } from "@/lib/library-persistence";
import type { BoundDrawingSession } from "@/lib/session-owner";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

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
import { toast } from "./ui/toast";

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
  const { toggleSidebar } = useSidebar();

  const sessionRef = useRef<BoundDrawingSession | null>(null);
  useDrawingSession(fileId, saveFile, setFileDirty, sessionRef);

  const autosaveIntervalMs = useStore((s) => s.settings.autosaveIntervalMs);

  useEffect(() => {
    sessionRef.current?.setAutosaveInterval(autosaveIntervalMs);
  }, [autosaveIntervalMs]);

  const editorRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const libraryAdapter = useMemo(
    () => createLibraryPersistenceAdapter(defaultLibraryStorage()),
    [],
  );

  useHandleLibrary({ excalidrawAPI: excalidrawApi, adapter: libraryAdapter });

  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawApi(api);
  }, []);

  useEffect(() => {
    return window.api.library.onReturned((event) => {
      if (!event.hash || window.location.hash === event.hash) return;
      window.location.hash = event.hash;
    });
  }, []);

  useEffect(() => {
    const root = editorRef.current;

    const handleDrop = (event: DragEvent) => {
      const sceneFiles = [...(event.dataTransfer?.files ?? [])].filter((file) =>
        file.name.toLowerCase().endsWith(".excalidraw"),
      );
      if (sceneFiles.length === 0) return;

      event.preventDefault();
      event.stopPropagation();

      void (async () => {
        const opened: string[] = [];
        for (const file of sceneFiles) {
          try {
            const content = await file.text();
            const parsed: unknown = JSON.parse(content);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Drawing must be a JSON object");
            }
            const record = parsed as { elements?: unknown; files?: unknown };
            if ("elements" in record && !Array.isArray(record.elements)) {
              throw new Error("Drawing elements must be an array");
            }
            const created = await window.api.files.create(null, stripExcalidraw(file.name), "file");
            const saved = await useStore.getState().saveFile(created.id, content, "explicit");
            if (saved) opened.push(created.id);
          } catch (error) {
            toast.add({
              title: `Couldn’t import ${file.name}`,
              description: toAppError(error, "create").message,
              type: "error",
            });
          }
        }
        if (opened.length > 0) await useStore.getState().setOpenFileId(opened[0]);
      })();
    };

    root?.addEventListener("drop", handleDrop, true);
    return () => root?.removeEventListener("drop", handleDrop, true);
  }, []);

  const toggleSidebarRef = useRef(toggleSidebar);
  toggleSidebarRef.current = toggleSidebar;

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

  useHotkey("Mod+S", () => {
    void (async () => {
      const saved = await sessionRef.current?.saveNow();
      if (saved) toast.add({ title: "Saved", type: "success" });
    })();
  });

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      sessionRef.current?.onChange(elements, appState, files);
    },
    [],
  );

  // TODO: update this with renderTopLeftUI when a new release includes it
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

        const button = document.createElement("button");
        button.type = "button";
        button.className = "sidebar-toggle";
        button.setAttribute("aria-label", "Toggle sidebar");
        button.title = "Toggle sidebar";
        button.addEventListener("click", () => toggleSidebarRef.current());
        button.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

        host.appendChild(button);
        canvasActions.prepend(host);
        canvasActions.style.paddingLeft = "calc(var(--lg-button-size, 2.25rem) + 0.5rem)";
        anchor = host;
      }
    };

    if (root) {
      sync();
      observer = new MutationObserver(sync);
      observer.observe(root, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      anchor?.parentElement?.style.removeProperty("padding-left");
      anchor?.remove();
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
          excalidrawAPI={handleExcalidrawApi}
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
    </div>
  );
};
