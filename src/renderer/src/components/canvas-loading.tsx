export const CanvasLoading = () => {
  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--excalidraw-canvas-bg,var(--background))] text-sm"
      aria-busy="true"
      aria-label="Loading canvas"
    >
      <span>Loading canvas...</span>
    </div>
  );
};
