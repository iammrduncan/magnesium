// magnesium: a server's panel in Fleet (goal 35): its build, clock and backups, with Update, Roll back and Restore
import type { BackupList, FleetMachine } from "@magnesium/contracts";
import {
  buildOffers,
  confirmUpkeep,
  describePlace,
  fleetBackupNow,
  fleetBackups,
  fleetRestore,
  fleetRollback,
  fleetUpdate,
  restoreOffer,
  type UpkeepAsk,
  upkeepNotes,
  upkeepStatus,
  zoneName,
} from "@magnesium/web";
import { ChevronLeftIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { formatDay, formatTime } from "./fleetTime";

const pageUrl = () => window.location.href;
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The hub did not take that.";

/** A backup's size as people read it. */
const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 * 1024 * 1024
      ? `${Math.round(bytes / (1024 * 1024))} MB`
      : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;

const TONE_TEXT = {
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  info: "text-info-foreground",
  success: "text-success-foreground",
} as const;

function Fact({
  label,
  value,
  hint,
  hintTone,
  mono = false,
  action,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | null;
  readonly hintTone?: "warning" | "error" | null;
  readonly mono?: boolean;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border px-2.5 py-2 first:border-t-0">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm text-foreground", mono && "font-mono text-xs")}>
          {value}
        </span>
        {hint ? (
          <span className={cn("text-xs", hintTone ? TONE_TEXT[hintTone] : "text-muted-foreground")}>
            {hint}
          </span>
        ) : null}
      </span>
      {action}
    </div>
  );
}

/** Asks before an update, rollback or restore, saying what restarts. */
function ConfirmUpkeep({
  ask,
  machine,
  hub,
  onClose,
}: {
  readonly ask: UpkeepAsk | null;
  readonly machine: FleetMachine;
  readonly hub: FleetMachine | undefined;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = ask === null ? null : confirmUpkeep(ask, machine, hub);
  const run = () => {
    if (ask === null) return;
    setBusy(true);
    const done =
      ask.kind === "update"
        ? fleetUpdate(pageUrl(), machine.name)
        : ask.kind === "rollback"
          ? fleetRollback(pageUrl(), machine.name)
          : fleetRestore(pageUrl(), machine.name, ask.backup);
    void done
      .then(() => onClose())
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: `${confirm?.action ?? "That"} didn't start`,
          description: messageOf(cause),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <AlertDialog open={ask !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          <p className="text-sm text-muted-foreground">{confirm?.after}</p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant={confirm?.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={run}
          >
            {confirm?.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** A server's backups, newest first, with Back up now and Restore…. */
function BackupsView({
  machine,
  onBack,
  onRestore,
}: {
  readonly machine: FleetMachine;
  readonly onBack: () => void;
  readonly onRestore: (backup: string, when: string) => void;
}) {
  const [list, setList] = useState<BackupList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = machine.name ?? machine.label;
  const load = useCallback(() => {
    fleetBackups(pageUrl(), machine.name)
      .then((next) => {
        setList(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(messageOf(cause)));
  }, [machine.name]);
  useEffect(load, [load]);
  const restore = restoreOffer(machine);
  const failure = machine.backups?.failure ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" aria-label={`Back to ${name}`} onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          Backups of {name}
        </h2>
        <Button
          size="compact"
          variant="outline"
          disabled={busy || machine.link !== "connected"}
          onClick={() => {
            setBusy(true);
            fleetBackupNow(pageUrl(), machine.name)
              .then(() => {
                toastManager.add({ type: "success", title: `Backed up ${name}` });
                load();
              })
              .catch((cause: unknown) =>
                toastManager.add({
                  type: "error",
                  title: "The backup failed",
                  description: messageOf(cause),
                }),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Backing up…" : "Back up now"}
        </Button>
      </div>
      {error !== null ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      {failure !== null ? (
        <p className="rounded-md bg-destructive/8 px-2.5 py-2 text-sm text-destructive-foreground">
          The backup at {formatTime(failure.at)} failed: {failure.reason}
        </p>
      ) : null}
      {list === null && error === null ? (
        <p className="text-sm text-muted-foreground">Reading its backups…</p>
      ) : null}
      {list !== null && list.backups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No backups yet.</p>
      ) : null}
      {list !== null && list.backups.length > 0 ? (
        <ul className="overflow-hidden rounded-lg border border-border">
          {list.backups.map((backup) => (
            <li
              key={backup.name}
              className="flex items-center gap-2 border-t border-border px-2.5 py-2 first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-foreground">{formatDay(backup.at)}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(backup.bytes)}</span>
              </span>
              {restore.offered ? (
                <Button
                  size="compact"
                  variant="outline"
                  onClick={() => onRestore(backup.name, formatDay(backup.at).toLowerCase())}
                >
                  Restore…
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {name} backs up its own state every day and before each change. It keeps one backup a day
        for
        {list?.keep ?? 7} days, and its three newest. Restoring one backs up the state it replaces
        first.
        {restore.reason ? ` ${restore.reason}` : ""}
      </p>
    </div>
  );
}

/**
 * Everything Fleet runs on one server: its build and the one before, its time
 * zone and backups, each action asking first. The desktop shows it beside the
 * list; the phone in a sheet.
 */
export function ServerPanel({
  machine,
  hub,
  extraActions,
  now,
  initialAsk = null,
}: {
  readonly machine: FleetMachine;
  readonly hub: FleetMachine | undefined;
  /** The page's clock, to the minute: how old a backup is. */
  readonly now: number;
  /** An action to ask about as the panel opens, from the palette. */
  readonly initialAsk?: "update" | "rollback" | null;
  /** The server's other actions, such as Forget, below its facts. */
  readonly extraActions?: ReactNode;
}) {
  const [view, setView] = useState<"main" | "backups">("main");
  const [ask, setAsk] = useState<UpkeepAsk | null>(() =>
    initialAsk !== null && buildOffers(machine, hub)[initialAsk].offered
      ? { kind: initialAsk }
      : null,
  );

  const offers = buildOffers(machine, hub);
  const status = upkeepStatus(machine);
  const notes = upkeepNotes(machine, hub, now, formatTime);
  const isHub = machine.name === null;
  const has = (kind: (typeof notes)[number]["kind"]) => notes.some((note) => note.kind === kind);
  const behind = has("behind");
  const otherClock = has("clock");
  const backups = machine.backups;
  const stale = has("backup-old");
  const place = describePlace(machine);

  return (
    <div className="flex flex-col gap-4">
      {view === "main" ? (
        <>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-foreground">{machine.label}</h2>
              <p className="text-xs text-muted-foreground">
                {[isHub ? "the hub" : machine.name !== machine.label ? machine.name : null, place]
                  .filter(Boolean)
                  .join(" · ") || "a server"}
              </p>
            </div>
            <Badge
              size="sm"
              variant={
                machine.link === "connected"
                  ? "success"
                  : machine.link === "no-access"
                    ? "warning"
                    : "error"
              }
            >
              {machine.link === "connected"
                ? "Connected"
                : machine.link === "no-access"
                  ? "No access"
                  : machine.link === "connecting"
                    ? "Connecting"
                    : "Offline"}
            </Badge>
          </div>

          <section aria-label="Server" className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Server
            </h3>
            <div className="overflow-hidden rounded-lg border border-border">
              <Fact
                label="Build"
                mono
                value={machine.release ?? "Unknown"}
                hint={
                  isHub
                    ? "Every server follows it"
                    : behind
                      ? `Hub: ${hub?.release ?? "unknown"}`
                      : (offers.update.reason ??
                        (machine.release === null ? null : "Same as the hub"))
                }
                hintTone={behind ? "warning" : null}
                action={
                  offers.update.offered ? (
                    <Button
                      size="compact"
                      variant="outline"
                      onClick={() => setAsk({ kind: "update" })}
                    >
                      Update
                    </Button>
                  ) : null
                }
              />
              <Fact
                label="Before it"
                mono
                value={machine.previousRelease ?? "None"}
                hint={machine.previousRelease === null ? null : "Threads stay"}
                action={
                  offers.rollback.offered ? (
                    <Button
                      size="compact"
                      variant="outline"
                      onClick={() => setAsk({ kind: "rollback" })}
                    >
                      Roll back
                    </Button>
                  ) : null
                }
              />
              <Fact
                label="Time zone"
                value={machine.timeZone ?? "Unknown"}
                hint={
                  isHub || machine.timeZone === null
                    ? null
                    : otherClock
                      ? `Hub: ${hub?.timeZone ?? "unknown"}. Tasks here run on ${zoneName(machine.timeZone)} time`
                      : "Same as the hub"
                }
                hintTone={otherClock ? "warning" : null}
              />
              <Fact
                label="Backup"
                value={
                  backups === null
                    ? "Unknown"
                    : backups.failure !== null
                      ? `Failed ${formatTime(backups.failure.at)}`
                      : backups.newestAt === null
                        ? "None yet"
                        : formatDay(backups.newestAt)
                }
                hint={
                  backups?.failure != null
                    ? backups.failure.reason
                    : stale
                      ? "More than two days old"
                      : backups?.newestBytes != null && backups.count !== null
                        ? `${formatBytes(backups.newestBytes)} · ${backups.count} kept`
                        : null
                }
                hintTone={backups?.failure != null ? "error" : stale ? "warning" : null}
                action={
                  backups === null ? null : (
                    <Button size="compact" variant="outline" onClick={() => setView("backups")}>
                      Backups
                    </Button>
                  )
                }
              />
            </div>
            {status !== null ? (
              <p
                role="status"
                className={cn("rounded-md bg-muted px-2.5 py-2 text-sm", TONE_TEXT[status.tone])}
              >
                {status.text}
              </p>
            ) : null}
            {offers.rollback.reason !== null && offers.rollback.reason !== offers.update.reason ? (
              <p className="text-xs text-muted-foreground">{offers.rollback.reason}</p>
            ) : null}
            {machine.link !== "connected" && machine.link !== "connecting" ? (
              <p className="text-xs text-muted-foreground">
                Update, roll back and backups wait until it reconnects.
              </p>
            ) : null}
            {extraActions ? <div className="flex flex-wrap gap-1.5">{extraActions}</div> : null}
          </section>
        </>
      ) : (
        <BackupsView
          machine={machine}
          onBack={() => setView("main")}
          onRestore={(backup, when) => setAsk({ kind: "restore", backup, when })}
        />
      )}
      <ConfirmUpkeep ask={ask} machine={machine} hub={hub} onClose={() => setAsk(null)} />
    </div>
  );
}
