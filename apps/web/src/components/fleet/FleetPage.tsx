// magnesium: Fleet, every server the hub reaches (goal 04), each one's panel to run it from (goal 35); goal 10 adds the board's cards
import { type FleetEvent, type FleetMachine, fleetMachineKey } from "@magnesium/contracts";
import {
  describeEvent,
  describeLink,
  describeThreads,
  describePlace,
  describeVersion,
  differsFromHub,
  KIND_HINT,
  fleetRows,
  upkeepNotes,
} from "@magnesium/web";
import { PlusIcon, TerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { currentFleetWatch, useFleetView } from "./fleetStore";
import { formatTime } from "./fleetTime";
import { AddMachineDialog, ForgetMachineDialog, GiveAccessAgainDialog } from "./MachineDialogs";
import { MachineTerminal } from "./MachineTerminal";
import { ServerPanel } from "./ServerPanel";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const LINK_DOT: Record<FleetMachine["link"], string> = {
  connected: "bg-success",
  connecting: "bg-muted-foreground/50",
  offline: "bg-destructive",
  "no-access": "bg-warning",
};

function MachineRow({
  machine,
  hub,
  selected,
  onSelect,
  onReconnect,
  now,
}: {
  readonly machine: FleetMachine;
  readonly hub: FleetMachine | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onReconnect: (name: string) => Promise<void>;
  readonly now: number;
}) {
  const hubRelease = hub?.release ?? null;
  const notes = upkeepNotes(machine, hub, now, formatTime);
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
    <li
      className={cn(
        "grid grid-cols-1 gap-x-4 gap-y-1 border-b border-border px-2 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_auto] sm:items-center",
        selected && "rounded-md bg-accent/60",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Show ${machine.label}`}
        onClick={onSelect}
        className="flex min-w-0 flex-col text-left"
      >
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
        {notes.map((note) => (
          <span
            key={note.kind}
            className={cn(
              "truncate text-xs",
              note.tone === "error" ? "text-destructive-foreground" : "text-warning-foreground",
            )}
          >
            {note.text}
          </span>
        ))}
      </button>
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

/** A machine's own actions under its facts: the hub's access to it, and leaving the list. */
function MachineActions({
  machine,
  onForgotten,
}: {
  readonly machine: FleetMachine;
  readonly onForgotten: () => void;
}) {
  const [dialog, setDialog] = useState<"access" | "forget" | null>(null);
  // The hub's pods and attached machines are added and taken out in Settings → Connections.
  if (machine.name === null || machine.deployment === "pod" || machine.deployment === "attached") {
    return null;
  }
  return (
    <>
      <Button size="compact" variant="outline" onClick={() => setDialog("access")}>
        Give access again
      </Button>
      <Button size="compact" variant="outline" onClick={() => setDialog("forget")}>
        Forget {machine.name}
      </Button>
      <GiveAccessAgainDialog
        machine={machine}
        open={dialog === "access"}
        onOpenChange={(open) => setDialog(open ? "access" : null)}
      />
      <ForgetMachineDialog
        machine={machine}
        open={dialog === "forget"}
        onOpenChange={(open) => setDialog(open ? "forget" : null)}
        onForgotten={onForgotten}
      />
    </>
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
  const hub = rows.find((row) => row.name === null);
  // The board's panel sits beside the list on a wide screen; a phone opens it in a sheet.
  const wide = useMediaQuery("lg");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const picked = rows.find((row) => fleetMachineKey(row) === selectedKey);
  const shown = picked ?? (wide ? hub : undefined);
  // Backups age by the minute; nothing on the page needs a finer clock.
  const now = Date.parse(useNowMinute());
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
          <span className="min-w-0 flex-1" />
          <Button size="compact" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add a machine
          </Button>
        </WorkspacePageHeader>
        <AddMachineDialog
          open={adding}
          onOpenChange={setAdding}
          onAdded={(name) => setSelectedKey(name)}
        />
        <div className="flex min-h-0 flex-1">
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
                        key={fleetMachineKey(machine)}
                        machine={machine}
                        hub={hub}
                        selected={
                          shown !== undefined && fleetMachineKey(shown) === fleetMachineKey(machine)
                        }
                        onSelect={() => setSelectedKey(fleetMachineKey(machine))}
                        onReconnect={reconnect}
                        now={now}
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
          {wide && shown !== undefined ? (
            <aside
              aria-label="Server"
              className="w-[380px] shrink-0 overflow-y-auto border-l border-border bg-card p-4"
            >
              <ServerPanel
                key={fleetMachineKey(shown)}
                machine={shown}
                hub={hub}
                now={now}
                extraActions={
                  <MachineActions machine={shown} onForgotten={() => setSelectedKey(null)} />
                }
              />
            </aside>
          ) : null}
        </div>
      </div>
      {wide ? null : (
        <Sheet
          open={shown !== undefined}
          onOpenChange={(open) => (open ? undefined : setSelectedKey(null))}
        >
          <SheetPopup side="bottom">
            <div className="max-h-[88dvh] overflow-y-auto p-4">
              <SheetTitle className="sr-only">{shown?.label ?? "Server"}</SheetTitle>
              {shown !== undefined ? (
                <ServerPanel
                  key={fleetMachineKey(shown)}
                  machine={shown}
                  hub={hub}
                  now={now}
                  extraActions={
                    <MachineActions machine={shown} onForgotten={() => setSelectedKey(null)} />
                  }
                />
              ) : null}
            </div>
          </SheetPopup>
        </Sheet>
      )}
    </SidebarInset>
  );
}
