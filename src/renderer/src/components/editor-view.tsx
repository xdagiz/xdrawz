import { ExcalidrawEditor } from "@/components/excalidraw-editor";
import { useStore } from "@/lib/store";

export const EditorView = () => {
  const openFileId = useStore((s) => s.openFileId);
  const editorEpoch = useStore((s) => s.editorEpoch);

  if (!openFileId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground text-sm">No file selected</p>
      </div>
    );
  }

  return <ExcalidrawEditor key={`${openFileId}:${editorEpoch}`} fileId={openFileId} />;
};
