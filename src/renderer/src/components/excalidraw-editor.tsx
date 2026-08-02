import { Excalidraw, restoreAppState, restoreElements } from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTheme } from "@/hooks/use-theme";
import { createSceneSession, type SceneSessionControls } from "@/lib/scene-session";
import { useStore } from "@/lib/store";

type SceneData = {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: ExcalidrawInitialDataState["files"];
};

const loadScene = async (fileId: string): Promise<ExcalidrawInitialDataState | null> => {
  try {
    const content = await window.api.files.read(fileId);
    const parsed: SceneData = JSON.parse(content);
    const rawElements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const rawAppState = parsed.appState ?? null;
    const files = parsed.files ?? undefined;

    // collaborators must be a Map for restore (JSON.parse yields a plain object)
    const appStateForRestore =
      rawAppState && typeof rawAppState === "object"
        ? ({ ...rawAppState } as Record<string, unknown>)
        : rawAppState;
    if (appStateForRestore && appStateForRestore.collaborators) {
      const c = appStateForRestore.collaborators;
      if (typeof c === "object" && !(c instanceof Map)) {
        appStateForRestore.collaborators = new Map(Object.entries(c as Record<string, unknown>));
      }
    }

    const elements = restoreElements(rawElements as ExcalidrawInitialDataState["elements"], null, {
      repairBindings: true,
    });
    const appState = restoreAppState(appStateForRestore as Partial<AppState> | null, null);

    return { elements, appState, files };
  } catch (error) {
    console.error("Failed to load excalidraw scene:", error);
    return null;
  }
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

  const initialData = useMemo(() => {
    return async (): Promise<ExcalidrawInitialDataState | null> => {
      return loadScene(fileId);
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

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <Excalidraw
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
    </div>
  );
};
