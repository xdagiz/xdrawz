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
    <Suspense
      fallback={
        <div className="bg-background pointer-events-none absolute inset-0 z-10 flex h-full w-full flex-col items-center justify-center">
          <p className="text-muted-foreground text-sm">Loading editor...</p>
        </div>
      }
    >
      <ExcalidrawEditor key={`${editorGeneration}`} fileId={openFileId} />
    </Suspense>
  );
};
