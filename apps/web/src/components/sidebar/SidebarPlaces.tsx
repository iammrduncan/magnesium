// magnesium: the places at the top of the sidebar, as on the Home and Session boards.
// Each place appears when its goal lands: Home (goal 06) and Fleet (goal 04) so far.
import { Link, useLocation } from "@tanstack/react-router";
import { HouseIcon, ServerIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { countOffline, useFleetView } from "../fleet/fleetStore";
import { useHomeView } from "../home/homeStore";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export const SidebarPlaces = memo(function SidebarPlaces() {
  const { isMobile, setOpenMobile } = useSidebar();
  const onFleet = useLocation({ select: (location) => location.pathname === "/fleet" });
  const onHome = useLocation({ select: (location) => location.pathname === "/home" });
  const offline = countOffline(useFleetView());
  const needs = useHomeView().summary?.counts.total ?? 0;
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <nav aria-label="Places">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={onHome}
            render={<Link to="/home" onClick={closeMobileSidebar} />}
          >
            <HouseIcon />
            <span className="min-w-0 flex-1 truncate">Home</span>
            {needs > 0 ? (
              <span
                aria-label={`${needs} need you`}
                className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-warning/16 px-1 text-2xs font-semibold text-warning-foreground tabular-nums dark:bg-warning/24"
              >
                {needs}
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
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
