import { Folder, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { toAppError, type AppError } from "@/lib/app-error";

const handleQuit = () => void window.api.app.quit();

export function Greeting() {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleQuit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handlePick = async () => {
    setError(null);
    setPicking(true);

    try {
      await window.api.drawings.pick();
    } catch (err) {
      setError(toAppError(err, "folder"));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="h-screen overflow-hidden">
      <div className="fixed inset-x-0 top-0 flex h-9 items-center justify-end px-2 [-webkit-app-region:drag]">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={handleQuit}
          className="text-muted-foreground size-7 [-webkit-app-region:no-drag]"
        >
          <X />
        </Button>
      </div>

      <main className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="bg-primary text-primary-foreground border-border-quiet flex size-12 items-center justify-center rounded-xl border shadow-sm">
          <Folder className="size-6" />
        </div>

        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Choose your drawings folder</h1>
          <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
            xcalidraw stores drawings locally.
            <br />
            Pick a folder as your drawings library.
          </p>
        </div>

        <div className="mt-2 flex items-center gap-2 [-webkit-app-region:no-drag]">
          <Button onClick={handlePick} disabled={picking}>
            <Folder />
            {picking ? "Choosing…" : "Choose folder"}
          </Button>
          <Button variant="outline" onClick={handleQuit}>
            Cancel
          </Button>
        </div>

        {error && (
          <div className="max-w-xs space-y-1">
            <p className="text-sm font-medium">{error.title}</p>
            <p className="text-destructive font-mono text-xs break-words">{error.detail}</p>
          </div>
        )}
      </main>
    </div>
  );
}
