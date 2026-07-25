import { CSSProperties, useEffect, useRef } from "react";

import { useStore } from "@/lib/store";

import AppSidebar from "./components/app-sidebar";
import { ExcalidrawEditor } from "./components/excalidraw-editor";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";

const App = () => {
  const openFileId = useStore((s) => s.openFileId);
  const error = useStore((s) => s.error);
  const editorEpoch = useStore((s) => s.editorEpoch);
  const externalConflict = useStore((s) => s.externalConflict);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const ensureCleanOrConfirm = useStore((s) => s.ensureCleanOrConfirm);

  const conflictPromptRef = useRef<string | null>(null);

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

  useEffect(() => {
    return window.api.files.onChanged((event) => useStore.getState().applyEntries(event));
  }, []);

  useEffect(() => {
    return window.api.window.onWillClose(() => {
      void (async () => {
        const ok = await ensureCleanOrConfirm("quit");
        if (ok) await window.api.window.close();
      })();
    });
  }, [ensureCleanOrConfirm]);

  useEffect(() => {
    if (!externalConflict) {
      conflictPromptRef.current = null;
      return;
    }

    const key =
      externalConflict.type === "changed"
        ? `changed:${externalConflict.fileId}:${externalConflict.diskModifiedAt}`
        : `missing:${externalConflict.fileId}`;

    if (conflictPromptRef.current === key) return;
    conflictPromptRef.current = key;

    void (async () => {
      if (externalConflict.type === "changed") {
        const choice = await useStore.getState().resolveChangedConflict();
        if (choice === "cancel") {
          conflictPromptRef.current = null;
          return;
        }

        if (choice === "overwrite") await useStore.getState().activeSession?.saveNow();
        return;
      }

      if (externalConflict.type === "missing") {
        const choice = await useStore.getState().resolveMissingConflict();
        if (choice === "cancel") conflictPromptRef.current = null;
      }
    })();
  }, [externalConflict]);

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
        {error && (
          <div className="bg-destructive/10 text-destructive border-b px-3 py-1.5 text-xs">
            {error}
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {openFileId ? (
            <ExcalidrawEditor key={`${openFileId}:${editorEpoch}`} fileId={openFileId} />
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
