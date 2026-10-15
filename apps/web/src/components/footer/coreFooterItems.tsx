// magnesium: Magnesium's own footer items, Fleet and Needs you (goal 05, Footer board)
import { type FleetMachine, fleetMachineKey } from "@magnesium/contracts";
import { describeLink, describeWaiting, fleetRows, waitingByMachine } from "@magnesium/web";
import { Link } from "@tanstack/react-router";
import { TriangleIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useFleetView } from "../fleet/fleetStore";
import type { FooterItemRegistration, FooterPopoverProps } from "./footerRegistry";
import { FooterPopoverHeader, FooterPopoverNote } from "./FooterParts";

const LINK_DOT: Record<FleetMachine["link"], string> = {
  connected: "bg-success",
  connecting: "bg-muted-foreground/50",
  offline: "bg-destructive",
  "no-access": "bg-warning",
};

const clockTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const datedTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A time today as its clock time; an older one with its date. */
const formatTime = (iso: string) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? clockTime.format(date)
    : datedTime.format(date);
};

/** What the popover says while Fleet's own stream is not live, so it never shows stale rows. */
function FleetNotLive({ connection }: { readonly connection: "connecting" | "reconnecting" }) {
  return (
    <FooterPopoverNote>
      {connection === "connecting"
        ? "Connecting to the hub…"
        : "Can't reach the hub. Reconnecting…"}
    </FooterPopoverNote>
  );
}

function OpenFleetLink({ onClick }: { readonly onClick: () => void }) {
  return (
    <Link
      to="/fleet"
      onClick={onClick}
      className="mt-1 inline-flex self-start py-1 text-xs font-medium text-info-foreground hover:underline"
    >
      Open fleet
    </Link>
  );
}

/** Each machine with its link, and the way to Fleet. */
function FleetPopover({ close }: FooterPopoverProps) {
  const view = useFleetView();
  const machines = useMemo(() => fleetRows(view.machines), [view.machines]);
  return (
    <div className="flex flex-col text-xs">
      <FooterPopoverHeader title="Machines" />
      {view.connection !== "live" ? (
        <FleetNotLive connection={view.connection} />
      ) : (
        <ul className="flex flex-col">
          {machines.map((machine) => (
            <li key={fleetMachineKey(machine)} className="flex items-center gap-2 py-1">
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", LINK_DOT[machine.link])}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">{machine.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {describeLink(machine, formatTime)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <OpenFleetLink onClick={close} />
    </div>
  );
}

/** What waits on you, machine by machine, with the waiting threads this browser already holds. */
function NeedsYouPopover({ close }: FooterPopoverProps) {
  const fleet = useFleetView();
  const threads = useThreadShells();
  const groups = useMemo(
    () => waitingByMachine(fleetRows(fleet.machines), threads),
    [fleet.machines, threads],
  );
  return (
    <div className="flex flex-col text-xs">
      <FooterPopoverHeader title="Needs you" />
      {fleet.connection !== "live" ? (
        <FleetNotLive connection={fleet.connection} />
      ) : groups.length === 0 ? (
        <FooterPopoverNote>Nothing waits on you.</FooterPopoverNote>
      ) : (
        groups.map((group) => (
          <section key={fleetMachineKey(group.machine)} className="flex flex-col py-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {group.machine.label}
              </span>
              <span
                className={cn(
                  "shrink-0",
                  group.machine.threads === null
                    ? "text-muted-foreground"
                    : "text-warning-foreground",
                )}
              >
                {describeWaiting(group.machine.threads)}
              </span>
            </div>
            {group.threads.length > 0 ? (
              <ul className="-mx-1 mt-0.5 flex flex-col">
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: thread.environmentId, threadId: thread.id }}
                      onClick={close}
                      className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-foreground hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {thread.hasPendingApprovals ? "Approval" : "Question"}
                      </span>
                    </Link>
                  </li>
                ))}
                {group.more > 0 ? (
                  <li className="px-1 py-0.5 text-muted-foreground">{group.more} more</li>
                ) : null}
              </ul>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}

function NeedsYouMark() {
  return <TriangleIcon aria-hidden className="size-2.5 shrink-0 fill-current" />;
}

/** Registered at startup through the same registry app items use; the hub sends their rows. */
export const CORE_FOOTER_ITEMS: ReadonlyArray<FooterItemRegistration> = [
  { id: "core:fleet", Popover: FleetPopover },
  { id: "core:needs-you", Popover: NeedsYouPopover, Mark: NeedsYouMark },
];
