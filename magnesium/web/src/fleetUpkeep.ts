import { type FleetMachine, MAGNESIUM_WS_METHODS } from "@magnesium/contracts";

import { callHub } from "./spokes.ts";

/**
 * Fleet's upkeep (goal 35): what a server's row and panel say about its build,
 * backups and clock, which of Update, Roll back and Restore it offers, and what
 * each asks before it runs. The hub does the work; see `FleetUpkeep` there.
 */

/** A backup older than this gets a warning. */
export const STALE_BACKUP_MS = 2 * 24 * 60 * 60 * 1000;

export interface UpkeepNote {
  readonly kind: "behind" | "backup-failed" | "no-backup" | "backup-old" | "clock";
  readonly tone: "warning" | "error";
  readonly text: string;
}

/** The city in a time zone, as people say it: `America/New_York` is New York. */
export const zoneName = (zone: string) => (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");

/** What needs a look on a server: a build behind the hub's, a failed or old backup, another clock. */
export const upkeepNotes = (
  machine: FleetMachine,
  hub: FleetMachine | undefined,
  now: number,
  formatTime: (iso: string) => string,
): ReadonlyArray<UpkeepNote> => {
  const notes: Array<UpkeepNote> = [];
  if (
    machine.name !== null &&
    machine.release !== null &&
    hub?.release != null &&
    machine.release !== hub.release
  ) {
    notes.push({
      kind: "behind",
      tone: "warning",
      text: `On ${machine.release}, not the hub's ${hub.release}`,
    });
  }
  const backups = machine.backups;
  if (backups?.failure != null) {
    notes.push({
      kind: "backup-failed",
      tone: "error",
      text: `Backup failed ${formatTime(backups.failure.at)}`,
    });
  } else if (backups !== null && backups.newestAt === null) {
    notes.push({ kind: "no-backup", tone: "warning", text: "No backup yet" });
  } else if (backups?.newestAt != null && now - Date.parse(backups.newestAt) > STALE_BACKUP_MS) {
    notes.push({
      kind: "backup-old",
      tone: "warning",
      text: `Newest backup is from ${formatTime(backups.newestAt)}`,
    });
  }
  if (
    machine.name !== null &&
    machine.timeZone !== null &&
    hub?.timeZone != null &&
    machine.timeZone !== hub.timeZone
  ) {
    notes.push({
      kind: "clock",
      tone: "warning",
      text: `Clock on ${zoneName(machine.timeZone)} time, not the hub's ${zoneName(hub.timeZone)}`,
    });
  }
  return notes;
};

/** Whether an action is offered, or why not when that is worth saying. */
export interface Offer {
  readonly offered: boolean;
  readonly reason: string | null;
}

const offer: Offer = { offered: true, reason: null };
const quietly: Offer = { offered: false, reason: null };
const not = (reason: string): Offer => ({ offered: false, reason });

/** Update and Roll back for a server: what its kind and state allow (D70). */
export const buildOffers = (
  machine: FleetMachine,
  hub: FleetMachine | undefined,
): { readonly update: Offer; readonly rollback: Offer } => {
  if (machine.link !== "connected" || machine.activity !== null) {
    return { update: quietly, rollback: quietly };
  }
  if (machine.deployment === "attached") {
    const reason = "Its workload's deploy sets its build.";
    return { update: not(reason), rollback: not(reason) };
  }
  const behind =
    machine.name !== null &&
    machine.release !== null &&
    hub?.release != null &&
    machine.release !== hub.release;
  const rollback = machine.previousRelease === null ? quietly : offer;
  // A pod changes build through its gateway; anything else needs its launcher.
  if (machine.deployment === "pod" && machine.name !== null) {
    return { update: behind ? offer : quietly, rollback };
  }
  if (machine.launcher !== "systemd") {
    const reason = "Nothing on it restarts it on another build: change it with its deploy.";
    return { update: behind ? not(reason) : quietly, rollback: quietly };
  }
  return { update: behind ? offer : quietly, rollback };
};

/** Restore needs something that starts the server again once the backup is back. */
export const restoreOffer = (machine: FleetMachine): Offer =>
  machine.link !== "connected" || machine.activity !== null
    ? quietly
    : machine.launcher === null
      ? not("Nothing on it starts it again: restore with magnesium-release there.")
      : offer;

export type UpkeepAsk =
  | { readonly kind: "update" }
  | { readonly kind: "rollback" }
  | { readonly kind: "restore"; readonly backup: string; readonly when: string };

export interface UpkeepConfirm {
  readonly title: string;
  readonly body: string;
  readonly after: string;
  readonly action: string;
  readonly destructive: boolean;
}

/** What an action asks before it runs: what restarts, and what happens if it goes wrong. */
export const confirmUpkeep = (
  ask: UpkeepAsk,
  machine: FleetMachine,
  hub: FleetMachine | undefined,
): UpkeepConfirm => {
  const name = machine.name ?? machine.label;
  const isHub = machine.name === null;
  const isPod = machine.deployment === "pod";
  switch (ask.kind) {
    case "update":
      return {
        title: `Update ${name} to ${hub?.release ?? "the hub's build"}?`,
        body: isPod
          ? `${name}'s pod restarts on the hub's build, through its gateway. Its home and threads stay.`
          : `Magnesium on ${name} restarts on the hub's build. Its threads pause for a minute and carry on.`,
        after: `If the new build doesn't start, ${name} goes back to ${machine.release ?? "its build"}, and Fleet says why.`,
        action: "Update",
        destructive: false,
      };
    case "rollback":
      return {
        title: `Roll ${name} back to ${machine.previousRelease ?? "its build before"}?`,
        body: isHub
          ? "The hub restarts on the build it had before. This page loses it for a minute and reconnects on its own."
          : `Magnesium on ${name} restarts on the build it had before. Its threads stay.`,
        after: `${machine.release ?? "Its build now"} stays on ${name}, so you can go forward again.`,
        action: "Roll back",
        destructive: false,
      };
    case "restore":
      return {
        title: `Restore ${name} from ${ask.when}?`,
        body: `Magnesium on ${name} stops, backs up the state it has now, puts back the state from ${ask.when}, and starts again.`,
        after:
          "Threads and settings changed there since then go back to how they were. The restore runs on its own, so closing this page doesn't stop it.",
        action: "Restore",
        destructive: true,
      };
  }
};

/** Work under way on a server, or how the last update, rollback or restore went. */
export const upkeepStatus = (
  machine: FleetMachine,
): { readonly tone: "info" | "success" | "error"; readonly text: string } | null => {
  if (machine.activity !== null) return { tone: "info", text: machine.activity.text };
  const result = machine.lastResult;
  if (result === null || result.kind === "backup") return null;
  return { tone: result.ok ? "success" : "error", text: result.detail };
};

// The hub's RPCs; `machine` is the hub's name for it, null for the hub.
export const fleetBackups = (pageUrl: string, machine: string | null) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.fleetBackups]({ machine }));

export const fleetBackupNow = (pageUrl: string, machine: string | null) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.fleetBackupNow]({ machine }));

export const fleetRestore = (pageUrl: string, machine: string | null, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.fleetRestore]({ machine, name }));

export const fleetRollback = (pageUrl: string, machine: string | null) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.fleetRollback]({ machine }));

export const fleetUpdate = (pageUrl: string, machine: string | null) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.fleetUpdate]({ machine }));
