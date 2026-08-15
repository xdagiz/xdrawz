import type { ThemePreference } from "@shared/ipc";
import { useNavigate } from "@tanstack/react-router";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useEffect } from "react";

import { toAppError } from "@/lib/app-error";
import { useStore } from "@/lib/store";

import { Field, FieldContent, FieldLabel, FieldTitle } from "./ui/field";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
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

export const SettingsPage = () => {
  const theme = useStore((s) => s.settings.theme);
  const updateSettings = useStore((s) => s.updateSettings);
  const navigate = useNavigate();

  const handleThemeChange = async (value: ThemePreference) => {
    try {
      await updateSettings({ theme: value });
    } catch (error) {
      toast.add({ title: toAppError(error, "settings", false).message, type: "error" });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void navigate({ to: "/" });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <div className="bg-sidebar flex h-full items-center justify-center">
      <div className="bg-background w-full max-w-lg rounded-md border p-6">
        <div className="flex flex-col items-start gap-2">
          <span className="pl-2">Theme</span>
          <RadioGroup
            value={theme}
            onValueChange={(value) => void handleThemeChange(value as ThemePreference)}
            className="mx-auto w-full max-w-md grid-cols-3 gap-4"
          >
            {THEME_OPTIONS.map((option) => (
              <FieldLabel
                key={option.value}
                htmlFor={`theme-${option.value}`}
                className="bg-sidebar relative hover:cursor-pointer"
              >
                <Field orientation="vertical" className="items-center">
                  <FieldContent className="items-center gap-1.5">
                    <option.icon className="text-muted-foreground size-5" />
                    <FieldTitle>{option.label}</FieldTitle>
                  </FieldContent>
                </Field>
                <RadioGroupItem
                  value={option.value}
                  id={`theme-${option.value}`}
                  className="absolute top-3 right-3 opacity-0"
                />
              </FieldLabel>
            ))}
          </RadioGroup>
        </div>
      </div>
    </div>
  );
};
