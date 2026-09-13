import {
  Excalidraw,
  WelcomeScreen,
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
import {
  ArrowLeftIcon,
  FilePlus2Icon,
  FolderOpen,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useTheme } from "@/hooks/use-theme";
import { libraryErrorToastId, saveErrorToastId, toAppError, type AppError } from "@/lib/app-error";
import { createDrawingSession, drawingSignature } from "@/lib/drawing-session";
import { createLibraryPersistenceAdapter, defaultLibraryStorage } from "@/lib/library-persistence";
import { sessionOwner, type BoundDrawingSession } from "@/lib/session-owner";
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

type PendingScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

const SCRATCH_CREATE_ERROR_TOAST_ID = "scratch-create";

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
  fileId: string | null;
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
  const { toggleSidebar, open } = useSidebar();
  const createEntry = useStore((s) => s.createEntry);
  const createAndOpenEntry = useStore((s) => s.createAndOpenEntry);
  const openReservedFile = useStore((s) => s.openReservedFile);
  const pickAndSwitchFolder = useStore((s) => s.pickAndSwitchFolder);

  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const autosaveIntervalMs = useStore((s) => s.settings.autosaveIntervalMs);
  const editorGeneration = useStore((s) => s.editorGeneration);
  const fileName = useStore((s) =>
    fileId ? (s.entries.find((e) => e.id === fileId)?.name ?? fileId) : "",
  );

  const editorRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<BoundDrawingSession | null>(null);
  const boundFileIdRef = useRef<string | null>(null);
  const reservedIdRef = useRef<string | null>(null);
  const pendingSceneRef = useRef<PendingScene | null>(null);
  const creatingRef = useRef(false);
  const generationRef = useRef(0);

  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const libraryAdapter = useMemo(
    () =>
      createLibraryPersistenceAdapter(defaultLibraryStorage(), {
        onSaveError: () => {
          toast.add({
            id: libraryErrorToastId,
            title: "Couldn’t save library",
            description: "New library items couldn’t be persisted and may be lost on restart.",
            type: "error",
          });
        },
        onSaveSuccess: () => {
          toast.close(libraryErrorToastId);
        },
      }),
    [],
  );

  useHandleLibrary({ excalidrawAPI: excalidrawApi, adapter: libraryAdapter });

  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawApi(api);
  }, []);

  useEffect(() => {
    return () => setExcalidrawApi(null);
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
    sessionRef.current?.setAutosaveInterval(autosaveIntervalMs);
  }, [autosaveIntervalMs]);

  useEffect(() => {
    const flushOnEdge = () => {
      void sessionRef.current?.flush();
    };
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") flushOnEdge();
    };

    window.addEventListener("blur", flushOnEdge);
    document.addEventListener("visibilitychange", flushOnHidden);
    window.addEventListener("beforeunload", flushOnEdge);

    return () => {
      window.removeEventListener("blur", flushOnEdge);
      document.removeEventListener("visibilitychange", flushOnHidden);
      window.removeEventListener("beforeunload", flushOnEdge);
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;

      const session = sessionRef.current;
      const reservedId = reservedIdRef.current;
      const bound = boundFileIdRef.current;

      sessionRef.current = null;
      boundFileIdRef.current = null;
      reservedIdRef.current = null;
      pendingSceneRef.current = null;
      creatingRef.current = false;

      if (session && sessionOwner.getSession() === session) {
        const activeId = sessionOwner.getActiveFileId();
        sessionOwner.releaseActive();
        if (activeId) useStore.getState().setFileDirty(activeId, false);
      }

      if (reservedId) {
        viewportCache.delete(reservedId);
        void window.api.files.delete(reservedId, "permanent").catch(() => undefined);
      }

      if (bound && useStore.getState().openFileId !== bound) viewportCache.delete(bound);
      useStore.getState().setPendingCanvasAction(false);
    };
  }, []);

  useEffect(() => {
    if (fileId === boundFileIdRef.current) return;
    if (
      fileId !== null &&
      fileId === reservedIdRef.current &&
      sessionRef.current &&
      sessionOwner.getSession() === sessionRef.current
    ) {
      boundFileIdRef.current = fileId;
      reservedIdRef.current = null;
      creatingRef.current = false;
      pendingSceneRef.current = null;
      return;
    }

    generationRef.current += 1;
    const scratch = sessionRef.current;
    const reserved = reservedIdRef.current;
    const bound = boundFileIdRef.current;

    if (reserved && scratch && sessionOwner.getSession() === scratch) {
      sessionOwner.releaseActive();
      useStore.getState().setFileDirty(reserved, false);
      viewportCache.delete(reserved);
      void window.api.files.delete(reserved, "permanent").catch(() => undefined);
    }

    if (fileId === null && scratch && !reserved && sessionOwner.getSession() === scratch) {
      sessionOwner.releaseActive();
      if (bound) useStore.getState().setFileDirty(bound, false);
    }

    sessionRef.current = null;
    boundFileIdRef.current = null;
    reservedIdRef.current = null;
    pendingSceneRef.current = null;
    creatingRef.current = false;

    if (fileId === null) {
      const api = excalidrawApi;
      const reset = () => {
        api?.resetScene();
        api?.history.clear();
      };
      if (api && api.getAppState().isLoading) {
        const unsubscribe = api.onChange((_elements, appState) => {
          if (appState.isLoading) return;
          unsubscribe();
          if (boundFileIdRef.current !== null) return;
          reset();
        });
      } else {
        reset();
      }
    }

    setLoadError(null);
    if (fileId === null) return;

    const acquired = sessionOwner.acquire(
      fileId,
      createDrawingSession({
        fileId,
        save: (sid, content, origin) => useStore.getState().saveFile(sid, content, origin),
        onDirtyChange: (sid, dirty) => useStore.getState().setFileDirty(sid, dirty),
        onSaveGaveUp: (failedId) => {
          toast.add({
            id: saveErrorToastId(failedId),
            title: "Autosave stopped",
            description: "Couldn't save after several attempts. Press Ctrl+S to retry.",
            type: "error",
            timeout: 0,
          });
        },
      }),
    );

    acquired.setAutosaveInterval(useStore.getState().settings.autosaveIntervalMs);
    sessionRef.current = acquired;
    boundFileIdRef.current = fileId;
  }, [fileId, excalidrawApi]);

  const startScratchCreation = useCallback(() => {
    if (creatingRef.current || sessionRef.current || reservedIdRef.current) return;
    creatingRef.current = true;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const startOpenFileId = useStore.getState().openFileId;

    useStore.getState().setPendingCanvasAction(true);

    void (async () => {
      try {
        const store = useStore.getState();
        const id = await createEntry(null, "file");
        if (!id) throw new Error("Could not create drawing");
        if (generation !== generationRef.current) {
          viewportCache.delete(id);
          void window.api.files.delete(id, "permanent").catch(() => undefined);
          creatingRef.current = false;
          pendingSceneRef.current = null;
          useStore.getState().setPendingCanvasAction(false);
          return;
        }

        const raw = await window.api.files.read(id);
        if (generation !== generationRef.current) {
          viewportCache.delete(id);
          void window.api.files.delete(id, "permanent").catch(() => undefined);
          creatingRef.current = false;
          pendingSceneRef.current = null;
          useStore.getState().setPendingCanvasAction(false);
          return;
        }

        const parsed: {
          elements?: unknown;
          appState?: Partial<AppState> | null;
          files?: BinaryFiles;
        } = JSON.parse(raw);

        const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
        const restoredAppState = restoreAppState(parsed.appState ?? null, null);
        const restoredElements = restoreElements(rawElements, null, { repairBindings: true });
        const diskBaseline = drawingSignature(
          restoredElements,
          restoredAppState,
          parsed.files ?? undefined,
        );
        const acquired = sessionOwner.acquire(
          id,
          createDrawingSession({
            fileId: id,
            save: (sid, content, origin) => useStore.getState().saveFile(sid, content, origin),
            onDirtyChange: (sid, dirty) => useStore.getState().setFileDirty(sid, dirty),
            onSaveGaveUp: (failedId) => {
              toast.add({
                id: saveErrorToastId(failedId),
                title: "Autosave stopped",
                description:
                  "Your latest strokes are still on the canvas and will save on the next change.",
                type: "error",
                timeout: 0,
              });
            },
          }),
        );

        if (generation !== generationRef.current) {
          if (sessionOwner.getSession() === acquired) sessionOwner.releaseActive();
          viewportCache.delete(id);
          void window.api.files.delete(id, "permanent").catch(() => undefined);
          creatingRef.current = false;
          pendingSceneRef.current = null;
          useStore.getState().setPendingCanvasAction(false);
          return;
        }

        acquired.setAutosaveInterval(store.settings.autosaveIntervalMs);
        acquired.setInitialBaseline(diskBaseline);

        // The first call primes the session baseline clean against the disk state;
        // the second seeds the captured strokes and schedules the first save.
        const captured = pendingSceneRef.current;
        if (captured) {
          acquired.onChange([], captured.appState, captured.files);
        }

        if (captured) {
          viewportCache.set(id, viewportOf(captured.appState));
          acquired.onChange(captured.elements, captured.appState, captured.files);
        }

        sessionRef.current = acquired;
        reservedIdRef.current = id;

        if (useStore.getState().openFileId !== startOpenFileId) {
          if (sessionOwner.getSession() === acquired) sessionOwner.releaseActive();
          useStore.getState().setFileDirty(id, false);
          viewportCache.delete(id);
          void window.api.files.delete(id, "permanent").catch(() => undefined);
          sessionRef.current = null;
          reservedIdRef.current = null;
          creatingRef.current = false;
          pendingSceneRef.current = null;
          useStore.getState().setPendingCanvasAction(false);
          return;
        }

        try {
          const opened = await openReservedFile(id);
          if (!opened) throw new Error("The drawing was removed before it could be opened");
        } catch (error) {
          if (generation !== generationRef.current) {
            creatingRef.current = false;
            pendingSceneRef.current = null;
            useStore.getState().setPendingCanvasAction(false);
            return;
          }
          if (sessionOwner.getSession() === acquired) sessionOwner.releaseActive();

          useStore.getState().setFileDirty(id, false);
          viewportCache.delete(id);
          void window.api.files.delete(id, "permanent").catch(() => undefined);

          creatingRef.current = false;
          pendingSceneRef.current = null;

          useStore.getState().setPendingCanvasAction(false);
          const appError = toAppError(error, "create");
          toast.add({
            id: SCRATCH_CREATE_ERROR_TOAST_ID,
            title: appError.title,
            description: appError.detail,
            type: "error",
          });
        }
      } catch (error) {
        if (generation !== generationRef.current) {
          creatingRef.current = false;
          pendingSceneRef.current = null;
          useStore.getState().setPendingCanvasAction(false);
          return;
        }

        creatingRef.current = false;
        pendingSceneRef.current = null;

        useStore.getState().setPendingCanvasAction(false);
        const appError = toAppError(error, "create");
        toast.add({
          id: SCRATCH_CREATE_ERROR_TOAST_ID,
          title: appError.title,
          description: appError.detail,
          type: "error",
        });
      }
    })();
  }, [createEntry, openReservedFile]);

  useEffect(() => {
    if (!isLoadingDrawings) return;
    generationRef.current += 1;

    const scratch = sessionRef.current;
    const reserved = reservedIdRef.current;
    const bound = boundFileIdRef.current;
    const owned = sessionOwner.getSession();
    const ownedId = sessionOwner.getActiveFileId();

    if (reserved && scratch && owned === scratch) {
      sessionOwner.releaseActive();
      useStore.getState().setFileDirty(reserved, false);
      viewportCache.delete(reserved);
      void window.api.files.delete(reserved, "permanent").catch(() => undefined);
    } else if (owned) {
      sessionOwner.releaseActive();
      if (ownedId) useStore.getState().setFileDirty(ownedId, false);
    }

    sessionRef.current = null;
    boundFileIdRef.current = null;
    reservedIdRef.current = null;
    pendingSceneRef.current = null;
    creatingRef.current = false;

    if (bound && useStore.getState().openFileId !== bound) viewportCache.delete(bound);
  }, [isLoadingDrawings]);

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
            const imported = await useStore
              .getState()
              .createFileWithContent(null, stripExcalidraw(file.name), content);
            if (imported) opened.push(imported);
          } catch (error) {
            toast.add({
              title: `Couldn’t import ${file.name}`,
              description: toAppError(error, "create").detail,
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
  const openRef = useRef(open);

  useEffect(() => {
    toggleSidebarRef.current = toggleSidebar;
  }, [toggleSidebar]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const sidebarButtonRef = useRef<HTMLButtonElement | null>(null);

  const initialData = useMemo(
    () => async () => {
      if (fileId === null) return null;
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
    },
    [fileId],
  );

  useHotkey("Mod+S", () => {
    void (async () => {
      const session = sessionRef.current;
      if (session) {
        const saved = await session.saveNow();
        if (saved) toast.add({ title: "Saved", type: "success" });
        return;
      }

      const scene = pendingSceneRef.current;
      if (scene?.elements.some((element) => !element.isDeleted)) {
        startScratchCreation();
      }
    })();
  });

  const innerKey = `${editorGeneration}:${loadAttempt}`;

  const handleCreate = useCallback(() => {
    if (useStore.getState().pendingCanvasAction) return;
    void (async () => {
      try {
        await createAndOpenEntry(null, "file");
      } catch (error) {
        const appError = toAppError(error, "create");
        toast.add({ title: appError.title, description: appError.detail, type: "error" });
      }
    })();
  }, [createAndOpenEntry]);

  const handleBack = useCallback(() => {
    void useStore.getState().openHome();
  }, []);

  const handleChooseFolder = useCallback(() => {
    if (useStore.getState().pendingCanvasAction) return;
    void pickAndSwitchFolder();
  }, [pickAndSwitchFolder]);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      if (fileId !== null) {
        if (!appState.isLoading) {
          viewportCache.set(fileId, viewportOf(appState));
        }
        sessionRef.current?.onChange(elements, appState, files);
        return;
      }

      if (appState.isLoading) return;
      const session = sessionRef.current;
      if (session && reservedIdRef.current) {
        viewportCache.set(reservedIdRef.current, viewportOf(appState));
        session.onChange(elements, appState, files);
        return;
      }

      pendingSceneRef.current = { elements, appState, files };

      const hasContent = elements.some((element) => !element.isDeleted);
      if (!hasContent) return;

      startScratchCreation();
    },
    [fileId, startScratchCreation],
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
        button.innerHTML = SIDEBAR_TOGGLE_ICONS[openRef.current ? "open" : "closed"];

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
  }, [editorRef]);

  useEffect(() => {
    const button = sidebarButtonRef.current;
    if (button) button.innerHTML = SIDEBAR_TOGGLE_ICONS[open ? "open" : "closed"];
  }, [open]);

  if (loadError && fileId !== null) {
    return (
      <div ref={editorRef} className="relative h-full min-h-0 w-full overflow-hidden">
        <Empty className="bg-background h-full border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon className="text-destructive" />
            </EmptyMedia>
            <EmptyTitle>{loadError.title}</EmptyTitle>
            <EmptyDescription>
              {loadError.message}
              <span className="mt-1 block font-mono text-xs break-all">{fileName}</span>
            </EmptyDescription>
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
      </div>
    );
  }

  return (
    <div ref={editorRef} className="relative h-full min-h-0 w-full overflow-hidden">
      <ErrorBoundary
        title="The drawing editor stopped working"
        description="Try again. Your saved drawings are still available from the sidebar."
        resetKeys={[loadAttempt, fileId]}
      >
        <Excalidraw
          key={innerKey}
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
        >
          {fileId === null ? (
            <WelcomeShared heading="Your drawings are stored locally.">
              <WelcomeScreen.Center.MenuItem
                onSelect={handleCreate}
                icon={<FilePlus2Icon size={16} />}
                disabled={pendingCanvasAction}
              >
                New drawing
              </WelcomeScreen.Center.MenuItem>
              <WelcomeScreen.Center.MenuItem
                onSelect={handleChooseFolder}
                icon={<FolderOpen size={16} />}
                disabled={pendingCanvasAction}
              >
                Choose folder
              </WelcomeScreen.Center.MenuItem>
            </WelcomeShared>
          ) : (
            <WelcomeShared heading="Start drawing.">
              <WelcomeScreen.Center.MenuItemHelp />
              <WelcomeScreen.Center.MenuItem
                onSelect={handleBack}
                icon={<ArrowLeftIcon size={16} />}
              >
                Back to recents
              </WelcomeScreen.Center.MenuItem>
            </WelcomeShared>
          )}
        </Excalidraw>
      </ErrorBoundary>
    </div>
  );
};

const WelcomeShared = ({ heading, children }: { heading: string; children: ReactNode }) => {
  return (
    <WelcomeScreen>
      <WelcomeScreen.Hints.ToolbarHint />
      <WelcomeScreen.Hints.HelpHint />
      <WelcomeScreen.Hints.MenuHint />
      <WelcomeScreen.Center>
        <WelcomeScreen.Center.Logo>
          <span className="text-foreground">xdrawz</span>
        </WelcomeScreen.Center.Logo>
        <WelcomeScreen.Center.Heading>{heading}</WelcomeScreen.Center.Heading>
        <WelcomeScreen.Center.Menu>{children}</WelcomeScreen.Center.Menu>
      </WelcomeScreen.Center>
    </WelcomeScreen>
  );
};
