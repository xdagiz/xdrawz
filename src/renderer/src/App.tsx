import { Outlet, useRouterState } from "@tanstack/react-router";
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { toAppError } from "@/lib/app-error";
import { conflictKeyOf, fileNameOf } from "@/lib/conflicts";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

import { AppSidebar } from "./components/app-sidebar";
import { EditorView } from "./components/editor-view";
import { ErrorBoundary } from "./components/error-boundary";
import { ThemeProvider } from "./components/theme-provider";
import { Button } from "./components/ui/button";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { toast } from "./components/ui/toast";

const App = () => {
  const error = useStore((s) => s.error);
  const reportError = useStore((s) => s.reportError);
  const externalConflict = useStore((s) => s.externalConflict);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const initSettings = useStore((s) => s.initSettings);
  const applyEntries = useStore((s) => s.applyEntries);
  const resolveChangedConflict = useStore((s) => s.resolveChangedConflict);
  const resolveMissingConflict = useStore((s) => s.resolveMissingConflict);
  const themePreference = useStore((s) => s.settings.theme);
  const drawings = useStore((s) => s.drawings);
  const entries = useStore((s) => s.entries);
  const watcherDown = useStore((s) => s.watcherDown);
  const reportWatcherError = useStore((s) => s.reportWatcherError);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const editorEpoch = useStore((s) => s.editorEpoch);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const conflictPromptRef = useRef<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);

  const folderMissing = drawings?.missing === true && entries.length === 0;
  const lastToastRef = useRef<string | null>(null);
  const lastWatcherRef = useRef<{ key: string; at: number } | null>(null);
  const lastFolderMissingRef = useRef<number | null>(null);

  const pickFolder = useCallback(async () => {
    setPickingFolder(true);
    try {
      await window.api.drawings.pick();
    } catch (err) {
      const appError = toAppError(err, "unexpected", false);
      toast.add({
        title: "Couldn’t choose the drawings folder",
        description: appError.message,
        type: "error",
      });
    } finally {
      setPickingFolder(false);
    }
  }, []);

  useEffect(() => {
    void initSettings();
  }, [initSettings]);

  useEffect(() => {
    if (!openFileId) {
      document.title = "xdrawz";
      return;
    }

    const name = stripExcalidraw(fileNameOf(entries, openFileId));
    const marker = dirtyById[openFileId] ? "* " : "";
    document.title = `${marker}${name} - xdrawz`;
  }, [openFileId, entries, dirtyById]);

  useEffect(() => {
    return window.api.files.onWatcherError((event) => reportWatcherError(event));
  }, [reportWatcherError]);

  useEffect(() => {
    if (!error) return;
    const key = error.id;

    if (lastToastRef.current === key) return;

    lastToastRef.current = key;
    toast.add({
      title: error.title,
      description: error.detail,
      type: "error",
    });
  }, [error]);

  useEffect(() => {
    if (!watcherDown) return;
    const now = Date.now();
    const key = watcherDown;

    if (
      lastWatcherRef.current &&
      lastWatcherRef.current.key === key &&
      now - lastWatcherRef.current.at < 1000
    ) {
      return;
    }

    lastWatcherRef.current = { key, at: now };
    toast.add({
      title: "Changes on disk may not appear",
      description: watcherDown,
      type: "warning",
    });
  }, [watcherDown]);

  useEffect(() => {
    if (!folderMissing) return;
    const now = Date.now();

    if (lastFolderMissingRef.current && now - lastFolderMissingRef.current < 1000) return;
    lastFolderMissingRef.current = now;

    toast.add({
      title: "Drawings folder is unavailable",
      description: "The folder holding your drawings can’t be found. Choose the folder again.",
      type: "error",
    });
  }, [folderMissing]);

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
          reportError(err, "load");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadSnapshot, reportError]);

  useEffect(() => {
    return window.api.files.onChanged((event) => applyEntries(event));
  }, [applyEntries]);

  useEffect(() => {
    if (!externalConflict) {
      conflictPromptRef.current = null;
      return;
    }

    const key = conflictKeyOf(externalConflict);

    if (conflictPromptRef.current === key) return;
    conflictPromptRef.current = key;

    void (async () => {
      if (externalConflict.type === "changed") {
        const choice = await resolveChangedConflict();
        if (choice === "cancel") return;

        if (choice === "overwrite") await useStore.getState().activeSession?.saveNow();
        return;
      }

      if (externalConflict.type === "missing") {
        await resolveMissingConflict();
      }
    })();
  }, [externalConflict, resolveChangedConflict, resolveMissingConflict]);

  return (
    <ThemeProvider preference={themePreference}>
      <SidebarProvider
        defaultOpen
        className="h-svh! min-h-svh overflow-hidden"
        // oxlint-disable typescript/no-unsafe-type-assertion
        style={
          {
            "--sidebar-width": "16rem",
          } as CSSProperties
        }
      >
        <AppSidebar />
        <SidebarInset className="isolation-isolate min-h-0 min-w-0 overflow-hidden">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ErrorBoundary resetKeys={[openFileId, editorEpoch]}>
              <EditorView />
            </ErrorBoundary>
            {folderMissing && (
              <div className="bg-background/80 absolute inset-0 flex items-center justify-center p-6">
                <div className="bg-card flex flex-col items-center gap-3 rounded-lg border p-6 shadow-sm">
                  <p className="text-sm font-medium">Drawings folder is unavailable</p>
                  <p className="text-muted-foreground max-w-xs text-center text-sm">
                    Choose the folder again to keep working.
                  </p>
                  <Button size="sm" disabled={pickingFolder} onClick={() => void pickFolder()}>
                    {pickingFolder ? "Choosing..." : "Choose folder"}
                  </Button>
                </div>
              </div>
            )}
            {pathname === "/settings" && (
              <div className="bg-sidebar absolute inset-0 z-10 overflow-y-auto">
                <Outlet />
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ThemeProvider>
  );
};

export default App;
