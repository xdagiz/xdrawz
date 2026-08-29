import { lazy, Suspense } from "react";

import { useStore } from "@/lib/store";

import { Home } from "./home";

const ExcalidrawEditor = lazy(() =>
  import("@/components/excalidraw-editor").then((m) => ({ default: m.ExcalidrawEditor })),
);

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const editorGeneration = useStore((s) => s.editorGeneration);

  if (!openFileId) return <Home />;

  return (
    <Suspense fallback={<div className="bg-background h-full w-full" />}>
      <ExcalidrawEditor key={`${editorGeneration}`} fileId={openFileId} />
    </Suspense>
  );
};
