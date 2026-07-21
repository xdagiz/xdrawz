import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useStore } from "@/lib/store";

const AppSidebar = () => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);
  const setOpenFileId = useStore((s) => s.setOpenFileId);
  const files = entries.filter((entry) => entry.kind === "file");

  return (
    <Sidebar side="left">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Drawings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {files.map((file) => (
                <SidebarMenuItem key={file.id}>
                  <SidebarMenuButton
                    isActive={file.id === openFileId}
                    tooltip={file.id}
                    onClick={() => setOpenFileId(file.id)}
                  >
                    <span>{file.name.replace(".excalidraw", "")}</span>
                  </SidebarMenuButton>
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
    </Sidebar>
  );
};

export default AppSidebar;
