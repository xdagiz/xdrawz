import { Outlet, useRouterState } from "@tanstack/react-router";
import { CSSProperties, useEffect, useRef } from "react";

import { useStore } from "@/lib/store";

import AppSidebar from "./components/app-sidebar";
import { EditorView } from "./components/editor-view";
import { ThemeProvider } from "./components/theme-provider";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";

const App = () => {
  const error = useStore((s) => s.error);
  const externalConflict = useStore((s) => s.externalConflict);
  const loadSnapshot = useStore((s) => s.loadSnapshot);
  const ensureCleanOrConfirm = useStore((s) => s.ensureCleanOrConfirm);
  const initSettings = useStore((s) => s.initSettings);
  const applyEntries = useStore((s) => s.applyEntries);
  const resolveChangedConflict = useStore((s) => s.resolveChangedConflict);
  const resolveMissingConflict = useStore((s) => s.resolveMissingConflict);
  const themePreference = useStore((s) => s.settings.theme);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const conflictPromptRef = useRef<string | null>(null);

  useEffect(() => {
    void initSettings();
  }, [initSettings]);

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
    return window.api.files.onChanged((event) => applyEntries(event));
  }, [applyEntries]);

  useEffect(() => {
    const unsubscribe = window.api.window.onWillClose((requestId) => {
      void (async () => {
        const ok = await ensureCleanOrConfirm("quit");
        if (ok) await window.api.window.close(requestId);
        else window.api.window.cancelQuit?.(requestId);
      })();
    });

    window.api.window.ready();
    return unsubscribe;
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
          {error && (
            <div className="bg-destructive/10 text-destructive border-b px-3 py-1.5 text-xs">
              {error}
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
