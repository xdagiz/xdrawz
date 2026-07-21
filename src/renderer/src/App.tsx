import { CSSProperties, useEffect } from "react";

import { useStore } from "@/lib/store";

import AppSidebar from "./components/app-sidebar";
import { ExcalidrawEditor } from "./components/excalidraw-editor";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";

const App = () => {
  const openFileId = useStore((s) => s.openFileId);
  const loadSnapshot = useStore((s) => s.loadSnapshot);

  useEffect(() => {
    let cancelled = false;

    window.api.drawings
      .load()
      .then((snapshot) => {
        if (!cancelled) {
          loadSnapshot(snapshot);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadSnapshot]);

  return (
    <SidebarProvider
      defaultOpen
      className="h-svh! min-h-svh overflow-hidden"
      style={
        {
          "--sidebar-width": "16rem",
        } as CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset className="isolation-isolate min-h-0 min-w-0 overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {openFileId ? (
            <ExcalidrawEditor key={openFileId} fileId={openFileId} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground text-sm">No file selected</p>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default App;
