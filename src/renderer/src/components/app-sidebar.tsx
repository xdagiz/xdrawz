import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeftIcon, SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useStore } from "@/lib/store";
import { stripExcalidraw } from "@/lib/utils";

const AppSidebar = () => {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const dirtyById = useStore((s) => s.dirtyById);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const renameFile = useStore((s) => s.renameFile);
  const deleteFile = useStore((s) => s.deleteFile);
  const files = entries.filter((entry) => entry.kind === "file");
  const isSettingsRoute = pathname === "/settings";

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent, fileId: string) => {
      event.preventDefault();

      const id = await window.api.contextMenu.show(
        [
          { id: "rename", label: "Rename" },
          { id: "delete", label: "Delete" },
        ],
        event.clientX,
        event.clientY,
      );

      switch (id) {
        case "rename":
          setRenamingId(fileId);
          break;
        case "delete": {
          const entry = entries.find((e) => e.id === fileId);
          const name = entry ? stripExcalidraw(entry.name) : fileId;
          if (window.confirm(`Delete "${name}"? This cannot be undone.`)) {
            try {
              await deleteFile(fileId);
            } catch (error) {
              console.error("Delete failed:", error);
            }
          }
          break;
        }
      }
    },
    [entries, deleteFile],
  );

  const handleRename = useCallback(
    async (fileId: string, newName: string) => {
      try {
        await renameFile(fileId, newName);
      } catch (error) {
        console.error("Rename failed:", error);
      } finally {
        setRenamingId(null);
      }
    },
    [renameFile],
  );

  const openDrawing = useCallback(
    async (fileId: string) => {
      if (fileId !== useStore.getState().openFileId) {
        await setOpenFileId(fileId);
        if (useStore.getState().openFileId !== fileId) return;
      }

      if (pathname !== "/") await navigate({ to: "/" });
    },
    [setOpenFileId, pathname, navigate],
  );

  return (
    <Sidebar side="left">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Drawings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {files.map((file) => (
                <SidebarMenuItem key={file.id}>
                  {renamingId === file.id ? (
                    <RenameInput
                      initial={stripExcalidraw(file.name)}
                      onCommit={(v) => handleRename(file.id, v)}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <SidebarMenuButton
                      isActive={!isSettingsRoute && file.id === openFileId}
                      tooltip={file.id}
                      onClick={() => void openDrawing(file.id)}
                      onContextMenu={(e) => handleContextMenu(e, file.id)}
                      data-dirty={dirtyById[file.id] ? "true" : undefined}
                      className="data-[dirty=true]:after:bg-primary relative pr-6 data-[dirty=true]:after:absolute data-[dirty=true]:after:top-1/2 data-[dirty=true]:after:right-2 data-[dirty=true]:after:size-1.5 data-[dirty=true]:after:-translate-y-1/2 data-[dirty=true]:after:rounded-full data-[dirty=true]:after:content-['']"
                    >
                      <span className="truncate">{stripExcalidraw(file.name)}</span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              ))}

              {files.length === 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    <span>No drawings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenuItem>
          {isSettingsRoute ? (
            <SidebarMenuButton onClick={() => void navigate({ to: "/" })}>
              <ArrowLeftIcon />
              Back
            </SidebarMenuButton>
          ) : (
            <SidebarMenuButton onClick={() => void navigate({ to: "/settings" })}>
              <SettingsIcon />
              Settings
            </SidebarMenuButton>
          )}
        </SidebarMenuItem>
      </SidebarFooter>
    </Sidebar>
  );
};

const RenameInput = ({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = useCallback(
    (action: "commit" | "cancel") => {
      if (finished.current) return;
      finished.current = true;
      if (action === "commit") {
        const trimmed = value.trim();
        if (trimmed) onCommit(trimmed);
        else onCancel();
      } else {
        onCancel();
      }
    },
    [value, onCommit, onCancel],
  );

  return (
    <Input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish("commit");
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish("cancel");
        }
      }}
      onBlur={() => finish("commit")}
      className="h-7 text-xs"
    />
  );
};

export default AppSidebar;
