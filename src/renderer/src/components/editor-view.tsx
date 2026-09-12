import { useRecentDrawings } from "@/hooks/use-recent-drawings";
import { useStore } from "@/lib/store";

import { ExcalidrawEditor } from "./excalidraw-editor";
import { Home } from "./home";

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const pendingCanvasAction = useStore((s) => s.pendingCanvasAction);
  const { recentFiles } = useRecentDrawings();

  if (openFileId) {
    return <ExcalidrawEditor key="canvas" fileId={openFileId} />;
  }

  if (recentFiles.length === 0 || pendingCanvasAction) {
    return <ExcalidrawEditor key="canvas" fileId={null} />;
  }

  return <Home />;
};
