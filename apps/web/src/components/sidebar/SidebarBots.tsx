// magnesium: the hub's profiles as bots under the places (goal 34, D68)
import { Link, useParams } from "@tanstack/react-router";
import { PlusIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { ProfileAvatar } from "../magnesium/ProfileAvatar";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { useBots } from "./useBots";

/**
 * Each profile the hub runs, as a bot: clicking it opens your conversation
 * with it, on the hub, and New conversation archives that one and starts
 * another. Profiles are configured from the Profiles place above.
 */
export const SidebarBots = memo(function SidebarBots() {
  const { isMobile, setOpenMobile } = useSidebar();
  const { hubId, bots, conversationOf, open, startOver } = useBots();
  const openThreadId = useParams({ strict: false, select: (params) => params.threadId ?? null });
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  if (hubId === null || bots.length === 0) return null;
  return (
    <nav aria-label="Profiles to talk to" className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2">
        <span className="min-w-0 flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Profiles
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New profile"
          render={<Link to="/profiles" search={{ new: true }} onClick={closeMobileSidebar} />}
        >
          <PlusIcon />
        </Button>
      </div>
      <SidebarMenu>
        {bots.map((bot) => {
          const conversation = conversationOf(bot);
          return (
            <SidebarMenuItem key={bot.name}>
              <div className="group/bot flex items-center gap-1">
                <SidebarMenuButton
                  isActive={conversation !== null && conversation.id === openThreadId}
                  onClick={() => {
                    closeMobileSidebar();
                    void open(bot);
                  }}
                >
                  <ProfileAvatar name={bot.displayName} accentColor={bot.accentColor} />
                  <span className="min-w-0 flex-1 truncate">{bot.displayName}</span>
                  {conversation?.hasPendingApprovals || conversation?.hasPendingUserInput ? (
                    <span
                      role="img"
                      aria-label={`${bot.displayName} needs you`}
                      className="size-2 shrink-0 rounded-full bg-warning"
                    />
                  ) : null}
                </SidebarMenuButton>
                {/* Shown on hover, as the sidebar's thread actions are. */}
                <span className="opacity-0 group-hover/bot:opacity-100 focus-within:opacity-100">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`New conversation with ${bot.displayName}`}
                    title="New conversation"
                    onClick={() => {
                      closeMobileSidebar();
                      void startOver(bot);
                    }}
                  >
                    <SquarePenIcon />
                  </Button>
                </span>
              </div>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </nav>
  );
});
