import { Excalidraw, restoreAppState, restoreElements } from "@excalidraw/excalidraw";

import "@excalidraw/excalidraw/index.css";
import type { AppState, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { useMemo } from "react";

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
  const initialData = useMemo(() => {
    return async (): Promise<ExcalidrawInitialDataState | null> => {
      return loadScene(fileId);
    };
  }, [fileId]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <Excalidraw
        key={fileId}
        theme="dark"
        initialData={initialData}
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
