import { lazy, Suspense } from "react";

import { useStore } from "@/lib/store";

import { HomeGrid } from "./home-grid";

const ExcalidrawEditor = lazy(() =>
  import("@/components/excalidraw-editor").then((m) => ({ default: m.ExcalidrawEditor })),
);

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const editorEpoch = useStore((s) => s.editorEpoch);

  if (!openFileId) {
    return <HomeGrid />;
  }

  return (
    <Suspense fallback={<div className="bg-background h-full w-full" />}>
      <ExcalidrawEditor key={`${openFileId}:${editorEpoch}`} fileId={openFileId} />
    </Suspense>
  );
};
