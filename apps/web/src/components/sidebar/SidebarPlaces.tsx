// magnesium: the places at the top of the sidebar, as on the Home and Session boards.
// Each place appears when its goal lands; Fleet (goal 04) is the first.
import { Link, useLocation } from "@tanstack/react-router";
import { ServerIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { countOffline, useFleetView } from "../fleet/fleetStore";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export const SidebarPlaces = memo(function SidebarPlaces() {
  const { isMobile, setOpenMobile } = useSidebar();
  const onFleet = useLocation({ select: (location) => location.pathname === "/fleet" });
  const offline = countOffline(useFleetView());
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <nav aria-label="Places">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={onFleet}
            render={<Link to="/fleet" onClick={closeMobileSidebar} />}
          >
            <ServerIcon />
            <span className="min-w-0 flex-1 truncate">Fleet</span>
            {offline > 0 ? (
              <span
                aria-label={`${offline} offline`}
                className="size-2 shrink-0 rounded-full bg-destructive"
                role="img"
              />
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </nav>
  );
});
