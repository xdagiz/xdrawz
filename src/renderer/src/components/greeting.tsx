import { Folder, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function Greeting() {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = async () => {
    setError(null);
    setPicking(true);

    try {
      const info = await window.api.drawings.pick();
      if (info) {
        return;
      }
      setPicking(false);
    } catch (err) {
      setError(cleanIpcError(err));
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
          onClick={() => window.close()}
          className="text-muted-foreground size-7 [-webkit-app-region:no-drag]"
        >
          <X />
        </Button>
      </div>

      <main className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl shadow-sm">
          <Folder className="size-6" />
        </div>

        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Choose your drawings folder</h1>
          <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
            xdrawz stores drawings as local{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">.excalidraw</code>{" "}
            files. Pick a folder once — we&rsquo;ll use it every time you open the app.
          </p>
        </div>

        <Button
          onClick={handlePick}
          disabled={picking}
          className="mt-2 [-webkit-app-region:no-drag]"
        >
          <Folder />
          {picking ? "Choosing…" : "Choose folder"}
        </Button>

        {error && <p className="text-destructive max-w-xs text-sm break-words">{error}</p>}
      </main>
    </div>
  );
}
