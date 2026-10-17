// magnesium: the first Fleet page, a plain list of every server the hub reaches (goal 04; goal 10 replaces it with the board)
import type { FleetEvent, FleetMachine } from "@magnesium/contracts";
import {
  describeEvent,
  describeLink,
  describeThreads,
  describePlace,
  describeVersion,
  differsFromHub,
  KIND_HINT,
  fleetRows,
} from "@magnesium/web";
import { TerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { currentFleetWatch, useFleetView } from "./fleetStore";
import { MachineTerminal } from "./MachineTerminal";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A time today as its clock time; an older one with its date. */
const formatTime = (iso: string) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? timeFormat.format(date)
    : dateTimeFormat.format(date);
};

const LINK_DOT: Record<FleetMachine["link"], string> = {
  connected: "bg-success",
  connecting: "bg-muted-foreground/50",
  offline: "bg-destructive",
  "no-access": "bg-warning",
};

function MachineRow({
  machine,
  hubRelease,
  onReconnect,
}: {
  readonly machine: FleetMachine;
  readonly hubRelease: string | null;
  readonly onReconnect: (name: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const environmentId = machine.environmentId;
  const canOpenTerminal = environmentId !== null && machine.link === "connected";
  const canReconnect =
    machine.name !== null && (machine.link === "offline" || machine.link === "no-access");
  const reconnect = () => {
    if (machine.name === null) return;
    setPending(true);
    setError(null);
    onReconnect(machine.name)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The hub did not take that."),
      )
      .finally(() => setPending(false));
  };
  // Under the label: the hub's name for it, when that differs, and where it runs.
  const subtitle = [
    machine.name !== null && machine.name !== machine.label ? machine.name : null,
    describePlace(machine),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <li className="grid grid-cols-1 gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_auto] sm:items-center">
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{machine.label}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
              <Badge size="sm" variant={machine.kind === "hub" ? "info" : "outline"}>
                {machine.kind}
              </Badge>
            </TooltipTrigger>
            <TooltipPopup>{KIND_HINT[machine.kind]}</TooltipPopup>
          </Tooltip>
        </div>
        {subtitle !== "" ? (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </div>
      <span
        className={cn(
          "truncate text-xs tabular-nums",
          differsFromHub(machine, hubRelease) ? "text-warning-foreground" : "text-muted-foreground",
        )}
      >
        {describeVersion(machine, hubRelease)}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", LINK_DOT[machine.link])} />
        <span className="truncate text-sm text-foreground">
          {describeLink(machine, formatTime)}
        </span>
      </div>
      <span
        className={cn(
          "truncate text-sm tabular-nums",
          machine.threads !== null && machine.threads.waiting > 0
            ? "text-warning-foreground"
            : "text-muted-foreground",
        )}
      >
        {describeThreads(machine.threads)}
      </span>
      <div className="flex items-center justify-start gap-2 sm:justify-end">
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
        {canReconnect ? (
          <Button size="compact" variant="outline" disabled={pending} onClick={reconnect}>
            Reconnect
          </Button>
        ) : null}
        {canOpenTerminal ? (
          <Button
            size="compact"
            variant="outline"
            aria-pressed={terminalOpen}
            onClick={() => setTerminalOpen((open) => !open)}
          >
            <TerminalIcon />
            Terminal
          </Button>
        ) : null}
      </div>
      {machine.detail !== null && machine.link !== "connected" ? (
        <p className="text-xs text-muted-foreground sm:col-span-5">{machine.detail}</p>
      ) : null}
      {terminalOpen && environmentId !== null ? (
        <div className="pt-2 sm:col-span-5">
          <MachineTerminal
            environmentId={environmentId}
            label={machine.label}
            onClose={() => setTerminalOpen(false)}
          />
        </div>
      ) : null}
    </li>
  );
}

function EventList({
  events,
  hasEarlier,
  onLoadEarlier,
}: {
  readonly events: ReadonlyArray<FleetEvent>;
  readonly hasEarlier: boolean;
  readonly onLoadEarlier: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const newestFirst = useMemo(() => events.toReversed(), [events]);
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No links have come up or gone down yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col">
        {newestFirst.map((event) => (
          <li
            key={event.sequence}
            className="flex items-baseline justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0"
          >
            <span className="min-w-0 text-foreground">{describeEvent(event)}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatTime(event.at)}
            </span>
          </li>
        ))}
      </ol>
      {hasEarlier ? (
        <div>
          <Button
            size="compact"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onLoadEarlier().finally(() => setPending(false));
            }}
          >
            Load earlier
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function FleetPage() {
  // Shared with the sidebar's Fleet place, so the two use one connection.
  const view = useFleetView();
  const rows = useMemo(() => fleetRows(view.machines), [view.machines]);
  const carriesMachines = rows.some((row) => row.name !== null);
  const hubRelease = rows.find((row) => row.name === null)?.release ?? null;
  const reconnect = (name: string) =>
    currentFleetWatch()?.reconnect(name) ?? Promise.reject(new Error("Not connected to the hub."));
  const loadEarlier = () => currentFleetWatch()?.loadEarlierEvents() ?? Promise.resolve();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Fleet breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Fleet</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {view.connection !== "live" ? (
              <p className="text-sm text-muted-foreground">
                {view.connection === "connecting"
                  ? "Connecting to the hub…"
                  : "Lost the hub. Reconnecting…"}
              </p>
            ) : null}
            {rows.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-foreground">Servers</h2>
                <ul className="flex flex-col">
                  {rows.map((machine) => (
                    <MachineRow
                      key={machine.name ?? "@self"}
                      machine={machine}
                      hubRelease={hubRelease}
                      onReconnect={reconnect}
                    />
                  ))}
                </ul>
                {carriesMachines ? null : (
                  <p className="text-sm text-muted-foreground">
                    This server carries no machines. On the hub, they come from its machine list.
                  </p>
                )}
              </section>
            ) : null}
            {carriesMachines ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-foreground">Recent</h2>
                <EventList
                  events={view.events.items}
                  hasEarlier={view.events.before !== null}
                  onLoadEarlier={loadEarlier}
                />
              </section>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
