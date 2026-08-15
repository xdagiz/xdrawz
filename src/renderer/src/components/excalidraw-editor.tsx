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
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "@/hooks/use-theme";
import { toAppError, type AppError } from "@/lib/app-error";
import { createSceneSession, sceneSignature, type SceneSessionControls } from "@/lib/scene-session";
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

type SceneData = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState> | null;
  files?: ExcalidrawInitialDataState["files"];
};

type LoadedScene = {
  scene: ExcalidrawInitialDataState | null;
  baseline: string | null;
};

const loadScene = async (fileId: string): Promise<LoadedScene> => {
  const content = await window.api.files.read(fileId);
  const parsed: SceneData = JSON.parse(content);
  const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
  const files = parsed.files ?? undefined;

  const appState = restoreAppState(parsed.appState ?? null, null);
  const elements = restoreElements(rawElements, null, {
    repairBindings: true,
  });

  return {
    scene: { elements, appState, files },
    baseline: sceneSignature(elements, appState, files),
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

  const sessionRef = useRef<SceneSessionControls | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const initialData = useMemo(() => {
    return async () => {
      try {
        const loaded = await loadScene(fileId);
        sessionRef.current?.setInitialBaseline(loaded.baseline);
        return loaded.scene;
      } catch (error) {
        console.error("Failed to load excalidraw scene:", error);
        sessionRef.current?.resetBaseline();
        setLoadError(toAppError(error, "read"));
        return null;
      }
    };
  }, [fileId]);

  useEffect(() => {
    const session = createSceneSession({
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      void sessionRef.current?.saveNow();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      sessionRef.current?.onChange(elements, appState, files);
    },
    [],
  );

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
    <div className="relative h-full min-h-0 w-full overflow-hidden">
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
    </div>
  );
};
