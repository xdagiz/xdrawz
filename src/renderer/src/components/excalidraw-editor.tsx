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
import { MAX_DRAWING_CONTENT_BYTES, validateDrawingRecord } from "@shared/ipc";
import { useHotkey } from "@tanstack/react-hotkeys";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDrawingSession } from "@/hooks/use-drawing-session";
import { useTheme } from "@/hooks/use-theme";
import { toAppError, type AppError } from "@/lib/app-error";
import { drawingSignature } from "@/lib/drawing-session";
import { createLibraryPersistenceAdapter, defaultLibraryStorage } from "@/lib/library-persistence";
import type { BoundDrawingSession } from "@/lib/session-owner";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";
import { applyViewport, createViewportCache, viewportOf } from "@/lib/viewport-cache";

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

const viewportCache = createViewportCache();

const loadDrawing = async (fileId: string): Promise<LoadedDrawing> => {
  const content = await window.api.files.read(fileId);
  const parsed: DrawingData = JSON.parse(content);
  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const files = parsed.files ?? undefined;

  const restored = restoreAppState(parsed.appState ?? null, null);
  const appState = applyViewport(restored, viewportCache.get(fileId));
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

const invert = (c: number) => Math.round(c * 0.07 + (255 - c) * 0.93);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const toHex = (c: number) => {
  const clamped = Number.isFinite(c) ? Math.max(0, Math.min(255, Math.round(c))) : 0;
  return clamped.toString(16).padStart(2, "0");
};

// Excalidraw renders the canvas background via `invert(0.93) hue-rotate(180deg)` in
// dark mode but stores the original color, so we replicate it to match the cushion.
const applyExcalidrawDarkModeFilter = (color: string) => {
  if (typeof color !== "string") return color;
  if (color.toLowerCase() === "transparent") return color;
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) return color;

  const hex = color.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  const ir = invert(r);
  const ig = invert(g);
  const ib = invert(b);

  const rn = ir / 255;
  const gn = ig / 255;
  const bn = ib / 255;

  const m = [-0.574, 1.43, 0.144, 0.426, 0.43, 0.144, 0.426, 1.43, -0.856];
  const nr = Math.round(clamp01(rn * m[0] + gn * m[1] + bn * m[2]) * 255);
  const ng = Math.round(clamp01(rn * m[3] + gn * m[4] + bn * m[5]) * 255);
  const nb = Math.round(clamp01(rn * m[6] + gn * m[7] + bn * m[8]) * 255);

  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
};

const SIDEBAR_TOGGLE_ICONS = {
  open: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left-close-icon lucide-panel-left-close"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>',
  closed:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-panel-left-open-icon lucide-panel-left-open"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>',
} as const;

export const ExcalidrawEditor = ({ fileId }: Props) => {
  const theme = useTheme();
  const saveFile = useStore((s) => s.saveFile);
  const setFileDirty = useStore((s) => s.setFileDirty);
  const { toggleSidebar, open } = useSidebar();

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

  useLayoutEffect(() => {
    if (excalidrawApi) return undefined;
    document.documentElement.style.setProperty(
      "--excalidraw-canvas-bg",
      theme === "dark" ? "#121212" : "#ffffff",
    );
    return () => {
      document.documentElement.style.removeProperty("--excalidraw-canvas-bg");
    };
  }, [excalidrawApi, theme]);

  useLayoutEffect(() => {
    if (!excalidrawApi) return undefined;

    const applyCanvasBackground = () => {
      const canvasBackground = excalidrawApi.getAppState().viewBackgroundColor;
      const effective =
        theme === "dark" ? applyExcalidrawDarkModeFilter(canvasBackground) : canvasBackground;
      document.documentElement.style.setProperty("--excalidraw-canvas-bg", effective);
    };

    applyCanvasBackground();
    const unsubscribe = excalidrawApi.onChange(applyCanvasBackground);

    return () => {
      unsubscribe();
      document.documentElement.style.removeProperty("--excalidraw-canvas-bg");
    };
  }, [excalidrawApi, theme]);

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
            if (new TextEncoder().encode(content).length > MAX_DRAWING_CONTENT_BYTES) {
              throw new Error("Drawing exceeds the size limit");
            }
            const parsed: unknown = JSON.parse(content);
            validateDrawingRecord(parsed);
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

  const sidebarButtonRef = useRef<HTMLButtonElement | null>(null);

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
      viewportCache.set(fileId, viewportOf(appState));
      sessionRef.current?.onChange(elements, appState, files);
    },
    [fileId],
  );

  useEffect(() => {
    return () => {
      if (useStore.getState().openFileId !== fileId) viewportCache.delete(fileId);
    };
  }, [fileId]);

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
        button.innerHTML = SIDEBAR_TOGGLE_ICONS[open ? "open" : "closed"];

        sidebarButtonRef.current = button;
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
      sidebarButtonRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    const button = sidebarButtonRef.current;
    if (button) button.innerHTML = SIDEBAR_TOGGLE_ICONS[open ? "open" : "closed"];
  }, [open]);

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
