// magnesium: the footer, a status bar across the bottom of the shell on every page (goal 05, Footer board)
import type { FooterItem, FooterTone } from "@magnesium/contracts";
import { footerToggles, layoutFooter, setFooterItemShown } from "@magnesium/web";
import { PlusIcon } from "lucide-react";
import { type ComponentProps, memo, useCallback, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type FooterItemRegistration,
  useFooterHidden,
  useFooterRegistrations,
} from "./footerRegistry";
import { FooterDotMark, FooterPopoverHeader, FooterPopoverNote } from "./FooterParts";
import { useFooterView } from "./footerStore";

const TONE_TEXT: Record<FooterTone | "muted", string> = {
  muted: "text-muted-foreground hover:text-foreground",
  neutral: "text-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

/** An item's face in the bar: a small mark and a short label, in its tone. */
function FooterItemButton({
  tone,
  className,
  ...props
}: ComponentProps<"button"> & { readonly tone: FooterTone | "muted" }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-6 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
        TONE_TEXT[tone],
        className,
      )}
    />
  );
}

/** What an item that failed to render leaves in its place, so the rest of the bar stays. */
function FooterItemFailed({ item }: { readonly item: FooterItem }) {
  return (
    <span className="inline-flex h-6 shrink-0 items-center px-1.5 text-xs text-muted-foreground">
      {item.toggleLabel} unavailable
    </span>
  );
}

/** One item: its label with the hub's detail as a tooltip, opening its popover. */
const FooterBarItem = memo(function FooterBarItem({
  item,
  registration,
}: {
  readonly item: FooterItem;
  readonly registration: FooterItemRegistration;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { Popover: Content, Mark = FooterDotMark } = registration;
  return (
    <RenderErrorBoundary
      fallback={<FooterItemFailed item={item} />}
      resetKeys={[item, registration]}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip disabled={open || item.detail === null}>
          <TooltipTrigger
            render={<PopoverTrigger render={<FooterItemButton tone={item.tone} />} />}
          >
            <Mark />
            <span className="truncate">{item.label}</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{item.detail}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" width="md" padding="compact">
          <RenderErrorBoundary
            fallback={<FooterPopoverNote>This item could not be shown.</FooterPopoverNote>}
          >
            <Content item={item} close={close} />
          </RenderErrorBoundary>
        </PopoverPopup>
      </Popover>
    </RenderErrorBoundary>
  );
});

/** Shown in place of the hub's items while its socket is down: no stale numbers. */
function FooterOffline() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex h-6 shrink-0 items-center gap-1.5 px-1.5 text-xs font-medium text-muted-foreground" />
        }
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
        Offline
      </TooltipTrigger>
      <TooltipPopup side="top">Can't reach the hub. Retrying.</TooltipPopup>
    </Tooltip>
  );
}

/** Every item the hub sends, each with a switch; what is off stays off on this device. */
function FooterSettingsList() {
  const rows = useFooterView((view) => view.table.rows);
  const registrations = useFooterRegistrations();
  const [hidden, setHidden] = useFooterHidden();
  const toggles = useMemo(
    () => footerToggles(rows.values(), registrations, hidden),
    [rows, registrations, hidden],
  );
  return (
    <div className="flex flex-col text-xs">
      <FooterPopoverHeader title="Footer" />
      {toggles.length === 0 ? (
        <FooterPopoverNote>No items yet. They appear when the hub answers.</FooterPopoverNote>
      ) : (
        <ul className="flex flex-col">
          {toggles.map((toggle) => (
            <li key={toggle.id} className="flex items-center justify-between gap-3 py-1">
              <span className="min-w-0 truncate text-foreground">{toggle.label}</span>
              <Switch
                size="sm"
                checked={toggle.shown}
                aria-label={`Show ${toggle.label} in the footer`}
                onCheckedChange={(shown) =>
                  setHidden((current) => setFooterItemShown(current, toggle.id, shown))
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FooterSettings() {
  return (
    <Popover>
      <PopoverTrigger render={<FooterItemButton tone="muted" aria-label="Choose footer items" />}>
        <PlusIcon aria-hidden className="size-3 shrink-0" />
        Footer
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" padding="compact">
        <FooterSettingsList />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The bar itself. Core items sit on the left, app items on the right (goal
 * 16), then "+ Footer". It holds one shared footer stream; while that is not
 * live it shows nothing from the hub, and "Offline" after a drop.
 */
export const AppFooter = memo(function AppFooter() {
  const rows = useFooterView((view) => view.table.rows);
  const connection = useFooterView((view) => view.connection);
  const registrations = useFooterRegistrations();
  const [hidden] = useFooterHidden();
  const layout = useMemo(
    () => layoutFooter(rows.values(), registrations, hidden),
    [rows, registrations, hidden],
  );
  const live = connection === "live";
  return (
    <footer
      aria-label="Status bar"
      className="fixed inset-x-0 bottom-0 z-20 flex h-(--app-footer-height) items-center justify-between gap-2 border-t border-border bg-sidebar px-2"
    >
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {connection === "reconnecting" ? <FooterOffline /> : null}
        {live
          ? layout.left.map((entry) => (
              <FooterBarItem
                key={entry.item.id}
                item={entry.item}
                registration={entry.registration}
              />
            ))
          : null}
      </div>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {live
          ? layout.right.map((entry) => (
              <FooterBarItem
                key={entry.item.id}
                item={entry.item}
                registration={entry.registration}
              />
            ))
          : null}
        <FooterSettings />
      </div>
    </footer>
  );
});
