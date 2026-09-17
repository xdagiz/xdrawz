import type { ErrorOperation } from "@shared/errors";
import type { ThemePreference } from "@shared/ipc";
import {
  FilePlus2,
  Folder,
  FolderPlus,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  RotateCcw,
  Save,
  Settings,
  Sun,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";

import { toast } from "@/components/ui/toast";
import { toAppError } from "@/lib/app-error";
import type { BoundDrawingSession } from "@/lib/session-owner";
import type { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

export type CommandRenderState = {
  openFileId: string | null;
  theme: ThemePreference;
};

export type CommandContext = {
  store: ReturnType<typeof useStore.getState>;
  session: BoundDrawingSession | null;
};

export type CommandDef = {
  id: string;
  title: string;
  group: "current" | "create" | "appearance" | "view" | "app";
  icon: LucideIcon;
  keywords?: string[];
  shortcut?: string;
  gatedOnConflict?: boolean;
  enabled?: (state: CommandRenderState) => boolean;
  disabledReason?: (state: CommandRenderState) => string;
  titleSuffix?: (state: CommandRenderState) => string;
  perform: (ctx: CommandContext) => void | Promise<void>;
};

export type CommandPaletteHooks = {
  openSettings: () => void;
  openRenameDialog: () => void;
  openDeleteDialog: () => void;
  toggleSidebar: () => void;
};

const OPEN_FILE_REQUIRED = "Open a drawing first";
const THEME_CHOICES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
  { value: "system", label: "System theme", icon: Monitor },
];

const reportFailure = (error: unknown, operation: ErrorOperation, title: string) => {
  const appError = toAppError(error, operation);
  toast.add({ title, description: appError.detail, type: "error" });
};

const requiresOpenFile = (state: CommandRenderState) => Boolean(state.openFileId);

const displayNameFor = (id: string) => stripExcalidraw(id.split("/").pop() ?? id);

export const buildCommands = (hooks: CommandPaletteHooks): CommandDef[] => [
  {
    id: "new-drawing",
    title: "New drawing",
    icon: FilePlus2,
    group: "create",
    keywords: ["file", "add", "create"],
    shortcut: "Mod+N",
    perform: async (ctx) => {
      try {
        const newId = await ctx.store.createEntry(null, "file");
        if (!newId) return;
        toast.add({ title: `Created ${displayNameFor(newId)}`, type: "success" });
      } catch (error) {
        reportFailure(error, "create", "Couldn’t create the drawing");
      }
    },
  },
  {
    id: "new-folder",
    title: "New folder",
    icon: FolderPlus,
    group: "create",
    keywords: ["directory", "add", "create"],
    shortcut: "Mod+Shift+N",
    perform: async (ctx) => {
      try {
        await ctx.store.createEntry(null, "directory");
      } catch (error) {
        reportFailure(error, "create", "Couldn’t create the folder");
      }
    },
  },
  {
    id: "save-now",
    gatedOnConflict: true,
    title: "Save now",
    icon: Save,
    group: "current",
    keywords: ["persist", "write"],
    shortcut: "Mod+S",
    enabled: requiresOpenFile,
    disabledReason: () => OPEN_FILE_REQUIRED,
    perform: async (ctx) => {
      if (!ctx.session) return;
      try {
        const saved = await ctx.session.saveNow();
        if (saved === "saved") toast.add({ title: "Saved", type: "success" });
      } catch (error) {
        reportFailure(error, "save", "Couldn’t save the drawing");
      }
    },
  },
  {
    id: "rename-drawing",
    gatedOnConflict: true,
    title: "Rename drawing",
    icon: Pencil,
    group: "current",
    keywords: ["change name"],
    enabled: requiresOpenFile,
    disabledReason: () => OPEN_FILE_REQUIRED,
    perform: () => {
      hooks.openRenameDialog();
    },
  },
  {
    id: "move-to-trash",
    gatedOnConflict: true,
    title: "Move to trash",
    icon: Trash2,
    group: "current",
    keywords: ["delete", "remove"],
    enabled: requiresOpenFile,
    disabledReason: () => OPEN_FILE_REQUIRED,
    perform: () => {
      hooks.openDeleteDialog();
    },
  },
  {
    id: "reload-from-disk",
    gatedOnConflict: true,
    title: "Reload from disk",
    icon: RotateCcw,
    group: "current",
    keywords: ["refresh", "revert"],
    enabled: requiresOpenFile,
    disabledReason: () => OPEN_FILE_REQUIRED,
    perform: async (ctx) => {
      try {
        if (!(await ctx.store.ensureCleanOrConfirm("switch"))) return;
        ctx.store.reloadOpenFileFromDisk();
      } catch (error) {
        reportFailure(error, "read", "Couldn’t reload the drawing");
      }
    },
  },
  {
    id: "close-drawing",
    title: "Close drawing",
    icon: X,
    group: "current",
    keywords: ["home", "exit"],
    enabled: requiresOpenFile,
    disabledReason: () => OPEN_FILE_REQUIRED,
    perform: async (ctx) => {
      try {
        await ctx.store.setOpenFileId(null);
      } catch (error) {
        reportFailure(error, "unexpected", "Couldn’t close the drawing");
      }
    },
  },
  ...THEME_CHOICES.map<CommandDef>(({ value, label, icon }) => ({
    id: `theme-${value}`,
    title: label,
    group: "appearance",
    icon,
    keywords: ["appearance", "mode"],
    titleSuffix: (state) => (state.theme === value ? " (active)" : ""),
    perform: async (ctx) => {
      try {
        await ctx.store.updateSettings({ theme: value });
      } catch (error) {
        reportFailure(error, "settings", "Couldn’t change the theme");
      }
    },
  })),
  {
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    icon: PanelLeft,
    group: "view",
    keywords: ["show", "hide", "panel"],
    shortcut: "Mod+B",
    perform: () => {
      hooks.toggleSidebar();
    },
  },
  {
    id: "open-settings",
    title: "Open settings",
    icon: Settings,
    group: "app",
    keywords: ["preferences", "options"],
    shortcut: "Mod+,",
    perform: () => {
      hooks.openSettings();
    },
  },
  {
    id: "choose-folder",
    title: "Choose drawings folder",
    icon: Folder,
    group: "app",
    keywords: ["storage", "location", "pick"],
    perform: async (ctx) => {
      await ctx.store.pickAndSwitchFolder();
    },
  },
];
