import type { ThemePreference } from "@shared/ipc";
import { AUTOSAVE_PRESETS_MS, isAutosavePresetMs } from "@shared/ipc";
import { CheckIcon, Folder, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { toAppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "./ui/field";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Switch } from "./ui/switch";
import { toast } from "./ui/toast";

type ThemeOption = {
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
};

const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const INK_LIGHT = "#26262c";
const INK_DARK = "#edecf1";

const SKETCH_STROKE = {
  fill: "none",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1,
} as const;

const CIRCLE_PATH =
  "M28.5 16.6c1.8 5.2-2.3 9.6-8 9.9-5.6.3-10.3-3-10.6-7.8C9.6 14 14 10.3 19.6 10c5.6-.3 7.4 2.6 8.9 6.6";
const ARROW_PATH = "M31 21.5c4.6 1.9 9.4 1.4 13.6-1.6";
const ARROW_HEAD_PATH = "M44.6 19.9l-4-.4m4 .4-1.2 3.7";
const SQUARE_PATH = "M50.5 11.8l10.8-1.2 1.4 10.4-10.9 1.3z";

type SketchProps = {
  ink: string;
};

const SolidSketch = ({ ink }: SketchProps) => (
  <svg viewBox="0 0 72 44" aria-hidden className="block h-auto w-full">
    <g transform="translate(0 5)">
      <path {...SKETCH_STROKE} stroke={ink} d={CIRCLE_PATH} />
      <path {...SKETCH_STROKE} stroke={ink} d={ARROW_PATH} />
      <path {...SKETCH_STROKE} stroke={ink} d={ARROW_HEAD_PATH} />
      <path {...SKETCH_STROKE} stroke={ink} d={SQUARE_PATH} />
    </g>
  </svg>
);

const SplitSketch = () => (
  <svg viewBox="0 0 72 44" aria-hidden className="block h-auto w-full">
    <rect width="36" height="44" fill="#ffffff" />
    <rect x="36" width="36" height="44" fill="#141419" />
    <g transform="translate(0 5)">
      <path {...SKETCH_STROKE} stroke={INK_LIGHT} d={CIRCLE_PATH} />
      <path {...SKETCH_STROKE} stroke={INK_LIGHT} d="M31 21.5c1.7.7 3.3 1.1 5 1.2" />
      <path {...SKETCH_STROKE} stroke={INK_DARK} d="M36 22.7c3 .3 5.9-.6 8.6-2.8" />
      <path {...SKETCH_STROKE} stroke={INK_DARK} d={ARROW_HEAD_PATH} />
      <path {...SKETCH_STROKE} stroke={INK_DARK} d={SQUARE_PATH} />
    </g>
  </svg>
);

const ThemePreview = ({ value }: { value: ThemePreference }) => {
  if (value === "light") {
    return (
      <svg viewBox="0 0 72 44" aria-hidden className="block h-auto w-full">
        <rect width="72" height="44" fill="#ffffff" />
        <SolidSketch ink={INK_LIGHT} />
      </svg>
    );
  }

  if (value === "dark") {
    return (
      <svg viewBox="0 0 72 44" aria-hidden className="block h-auto w-full">
        <rect width="72" height="44" fill="#141419" />
        <SolidSketch ink={INK_DARK} />
      </svg>
    );
  }

  return <SplitSketch />;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const SettingsDialog = ({ open, onOpenChange }: Props) => {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const drawings = useStore((s) => s.drawings);
  const pickAndSwitchFolder = useStore((s) => s.pickAndSwitchFolder);
  const [pickingFolder, setPickingFolder] = useState(false);

  const handleThemeChange = async (value: ThemePreference) => {
    try {
      await updateSettings({ theme: value });
    } catch (error) {
      toast.add({ title: toAppError(error, "settings").detail, type: "error" });
    }
  };

  const handleIntervalChange = async (value: number) => {
    try {
      await updateSettings({ autosaveIntervalMs: value });
    } catch (error) {
      toast.add({ title: toAppError(error, "settings").detail, type: "error" });
    }
  };

  const handleReopenChange = async (value: boolean) => {
    try {
      await updateSettings({ reopenLastDrawing: value });
    } catch (error) {
      toast.add({ title: toAppError(error, "settings").detail, type: "error" });
    }
  };

  const handleChangeFolder = async () => {
    setPickingFolder(true);
    try {
      const switched = await pickAndSwitchFolder();
      if (switched) onOpenChange(false);
    } finally {
      setPickingFolder(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] gap-0 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">Settings</DialogTitle>
        </DialogHeader>

        <div className="pt-2">
          <p className="text-muted-foreground text-xs font-medium">Appearance</p>
          <RadioGroup
            aria-label="Theme"
            value={settings.theme}
            onValueChange={(value) => {
              const option = THEME_OPTIONS.find((o) => o.value === value);
              if (option) void handleThemeChange(option.value);
            }}
            className="mt-3 grid grid-cols-3 gap-3"
          >
            {THEME_OPTIONS.map((option) => (
              <FieldLabel
                key={option.value}
                htmlFor={`theme-${option.value}`}
                className="bg-card has-[button[data-checked]]:border-primary hover:border-foreground/25 has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-ring/50 flex w-full cursor-pointer flex-col gap-0 overflow-hidden rounded-lg border text-left shadow-none transition-colors has-[button:focus-visible]:ring-1"
              >
                <span className="relative block">
                  <ThemePreview value={option.value} />
                  {settings.theme === option.value && (
                    <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full">
                      <CheckIcon className="size-3" />
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-center gap-1.5 py-2 text-xs font-medium">
                  <option.icon className="text-muted-foreground size-3.5" />
                  {option.label}
                </span>
                <span className="sr-only">
                  <RadioGroupItem value={option.value} id={`theme-${option.value}`} />
                </span>
              </FieldLabel>
            ))}
          </RadioGroup>
        </div>

        <div className="pt-6">
          <p className="text-muted-foreground text-xs font-medium">Autosave</p>
          <RadioGroup
            aria-label="Autosave interval"
            value={String(settings.autosaveIntervalMs)}
            onValueChange={(value) => {
              const ms = Number(value);
              if (isAutosavePresetMs(ms)) {
                void handleIntervalChange(ms);
              }
            }}
            className="mt-3 grid grid-cols-4 gap-3"
          >
            {AUTOSAVE_PRESETS_MS.map((ms) => (
              <FieldLabel
                key={ms}
                htmlFor={`autosave-${ms}`}
                className="bg-card has-[button[data-checked]]:border-primary hover:border-foreground/25 has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-ring/50 flex w-full cursor-pointer flex-col items-center gap-0 overflow-hidden rounded-lg border py-2.5 text-left shadow-none transition-colors has-[button:focus-visible]:ring-1"
              >
                <span className="flex items-center justify-center text-xs font-medium">
                  {`${ms / 1000}s`}
                </span>
                <span className="sr-only">
                  <RadioGroupItem value={String(ms)} id={`autosave-${ms}`} />
                </span>
              </FieldLabel>
            ))}
          </RadioGroup>
        </div>

        <div className="pt-6">
          <p className="text-muted-foreground text-xs font-medium">Startup</p>
          <Field orientation="horizontal" className="mt-3">
            <FieldContent>
              <FieldLabel htmlFor="reopen-last-drawing">Reopen last drawing</FieldLabel>
            </FieldContent>
            <Switch
              id="reopen-last-drawing"
              checked={settings.reopenLastDrawing}
              onCheckedChange={(value) => void handleReopenChange(value)}
            />
          </Field>
        </div>

        <div className="pt-6">
          <p className="text-muted-foreground text-xs font-medium">Storage</p>
          <Field orientation="horizontal" className="mt-3">
            <FieldContent>
              <FieldLabel>Drawings folder</FieldLabel>
              <FieldDescription className="font-mono text-xs break-all">
                {drawings?.path ?? "Not set"}
              </FieldDescription>
            </FieldContent>
            <Button
              variant="outline"
              size="sm"
              disabled={pickingFolder}
              onClick={() => void handleChangeFolder()}
            >
              <Folder className="size-3.5" />
              {pickingFolder ? "Choosing…" : "Change…"}
            </Button>
          </Field>
          {drawings?.missing && (
            <FieldDescription className="text-destructive mt-2">
              This folder can’t be found. Pick it again or choose a new one.
            </FieldDescription>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
