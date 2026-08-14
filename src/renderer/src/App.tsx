import { Outlet, useRouterState } from "@tanstack/react-router";
import { CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";
import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { toAppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";

import { AppSidebar } from "./components/app-sidebar";
import { EditorView } from "./components/editor-view";
import { ThemeProvider } from "./components/theme-provider";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { toast } from "./components/ui/toast";

const App = () => {
  const error = useStore((s) => s.error);
  const clearError = useStore((s) => s.clearError);
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
  const clearWatcherError = useStore((s) => s.clearWatcherError);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const conflictPromptRef = useRef<string | null>(null);
  const [folderMissingDismissed, setFolderMissingDismissed] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);

  const folderMissing = drawings?.missing === true && entries.length === 0;

  const pickFolder = useCallback(async () => {
    setPickingFolder(true);
    try {
      await window.api.drawings.pick();
    } catch (error) {
      const appError = toAppError(error, "unexpected", false);
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
    if (!folderMissing) setFolderMissingDismissed(false);
  }, [folderMissing]);

  useEffect(() => {
    void initSettings();
  }, [initSettings]);

  useEffect(() => {
    return window.api.files.onWatcherError((event) => reportWatcherError(event));
  }, [reportWatcherError]);

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

    const key =
      externalConflict.type === "changed"
        ? `changed:${externalConflict.fileId}:${externalConflict.diskModifiedAt}`
        : `missing:${externalConflict.fileId}`;

    if (conflictPromptRef.current === key) return;
    conflictPromptRef.current = key;

    void (async () => {
      if (externalConflict.type === "changed") {
        const choice = await resolveChangedConflict();
        if (choice === "cancel") {
          conflictPromptRef.current = null;
          return;
        }

        if (choice === "overwrite") await useStore.getState().activeSession?.saveNow();
        return;
      }

      if (externalConflict.type === "missing") {
        const choice = await resolveMissingConflict();
        if (choice === "cancel") conflictPromptRef.current = null;
      }
    })();
  }, [externalConflict, resolveChangedConflict, resolveMissingConflict]);

  return (
    <ThemeProvider preference={themePreference}>
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
          {!error && (
            <div className="flex flex-col gap-2 px-3 pt-3">
              {folderMissing && !folderMissingDismissed && (
                <Alert variant="destructive" className="shadow-sm">
                  <CircleAlertIcon />
                  <AlertTitle>Drawings folder is unavailable</AlertTitle>
                  <AlertDescription>
                    The folder holding your drawings can’t be found. Your files are safe — choose
                    the folder again to keep working.
                  </AlertDescription>
                  <div className="col-start-2 mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pickingFolder}
                      onClick={() => void pickFolder()}
                    >
                      {pickingFolder ? "Choosing…" : "Choose folder"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Dismiss"
                      onClick={() => setFolderMissingDismissed(true)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                </Alert>
              )}
              {watcherDown && (
                <Alert variant="default" className="shadow-sm">
                  <InfoIcon />
                  <AlertTitle>Changes on disk may not appear</AlertTitle>
                  <AlertDescription>
                    xdrawz couldn’t keep watching the drawings folder. Choose the folder again to
                    resume, or wait — it may recover on its own.
                  </AlertDescription>
                  <div className="col-start-2 mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pickingFolder}
                      onClick={() => void pickFolder()}
                    >
                      {pickingFolder ? "Choosing…" : "Choose folder"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Dismiss"
                      onClick={clearWatcherError}
                    >
                      <XIcon />
                    </Button>
                  </div>
                </Alert>
              )}
            </div>
          )}
          {error && (
            <div className="px-3 pt-3">
              <Alert variant="destructive" className="shadow-sm">
                <CircleAlertIcon />
                <AlertTitle>{error.title}</AlertTitle>
                <AlertDescription>{error.message}</AlertDescription>
                <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Dismiss error"
                    onClick={clearError}
                  >
                    <XIcon />
                  </Button>
                </div>
              </Alert>
            </div>
          )}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <EditorView />
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
