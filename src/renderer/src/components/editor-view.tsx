import { Suspense, lazy } from "react";

import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { useStore } from "@/lib/store";

import { CanvasLoading } from "./canvas-loading";
import { Home } from "./home";

const ExcalidrawEditor = lazy(() =>
  import("./excalidraw-editor").then((module) => ({ default: module.ExcalidrawEditor })),
);

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction);
  const isLoadingDrawings = useStore((s) => s.isLoadingDrawings);
  const { recentFiles } = useRecentDrawings();

  if (isLoadingDrawings) {
    return <CanvasLoading />;
  }

  if (openFileId === null && recentFiles.length > 0 && !pendingCanvasAction) {
    return <Home />;
  }

  return (
    <Suspense fallback={<CanvasLoading />}>
      <ExcalidrawEditor key="canvas" fileId={openFileId} />
    </Suspense>
  );
};
