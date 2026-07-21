import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { useStore } from "@/lib/store";

const AppSidebar = () => {
  const entries = useStore((s) => s.entries);
  const openFileId = useStore((s) => s.openFileId);

  return (
    <Sidebar side="left">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            {entries.map((e) => (
              <SidebarMenu key={e.id}>
                <SidebarMenuButton isActive={e.id == openFileId} tooltip={e.id}>
                  <span>{e.name}</span>
                  <span>{e.modifiedAt}</span>
                </SidebarMenuButton>
              </SidebarMenu>
            ))}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
};

export default AppSidebar;
