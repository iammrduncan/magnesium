import type { FleetMachine, FooterItem } from "@magnesium/contracts";

/**
 * Magnesium's own footer items, derived from Fleet's rows (goal 05). They are
 * plain rows like any app's, so the browser treats every item the same way.
 */

export const CORE_FLEET_ITEM_ID = "core:fleet";
export const CORE_NEEDS_YOU_ITEM_ID = "core:needs-you";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const labels = (machines: ReadonlyArray<FleetMachine>) =>
  machines
    .map((machine) => machine.label)
    .toSorted((left, right) => left.localeCompare(right))
    .join(", ");

/** The same rule as Fleet's place in the sidebar: a link that is down, or one the hub may not use. */
export const isOffline = (machine: FleetMachine) =>
  machine.link === "offline" || machine.link === "no-access";

/** Every server the hub reaches, the serving one included, and how many it can't reach. */
export const fleetItem = (machines: ReadonlyArray<FleetMachine>): FooterItem => {
  const offline = machines.filter(isOffline);
  const total = count(machines.length, "machine");
  const notes: Array<string> = [];
  const down = machines.filter((machine) => machine.link === "offline");
  const refused = machines.filter((machine) => machine.link === "no-access");
  const connecting = machines.filter((machine) => machine.link === "connecting");
  if (down.length > 0) notes.push(`Offline: ${labels(down)}.`);
  if (refused.length > 0) notes.push(`No access: ${labels(refused)}.`);
  if (connecting.length > 0) notes.push(`Connecting: ${labels(connecting)}.`);
  return {
    id: CORE_FLEET_ITEM_ID,
    side: "left",
    order: 10,
    label: offline.length === 0 ? total : `${total} · ${offline.length} offline`,
    detail: notes.length === 0 ? "All connected." : notes.join(" "),
    tone: offline.length === 0 ? "neutral" : "warning",
    toggleLabel: "Machines",
  };
};

/**
 * How many threads wait on you across the machines whose counts the hub can
 * see. A machine it can't see is named in the detail, never counted as zero.
 */
export const needsYouItem = (machines: ReadonlyArray<FleetMachine>): FooterItem => {
  let waiting = 0;
  let approvals = 0;
  let questions = 0;
  const unknown: Array<FleetMachine> = [];
  for (const machine of machines) {
    if (machine.threads === null) {
      unknown.push(machine);
      continue;
    }
    waiting += machine.threads.waiting;
    approvals += machine.threads.approvals;
    questions += machine.threads.questions;
  }
  const kinds = [
    approvals > 0 ? count(approvals, "approval") : null,
    questions > 0 ? count(questions, "question") : null,
  ].filter((kind) => kind !== null);
  const notes = [
    waiting > 0
      ? `${kinds.join(" and ")}.`
      : unknown.length > 0
        ? "Nothing waits on you on the machines the hub can see."
        : "Nothing waits on you.",
  ];
  if (unknown.length > 0) notes.push(`Not counted, not connected: ${labels(unknown)}.`);
  return {
    id: CORE_NEEDS_YOU_ITEM_ID,
    side: "left",
    order: 20,
    label: `Needs you ${waiting}`,
    detail: notes.join(" "),
    tone: waiting > 0 ? "warning" : "neutral",
    toggleLabel: "Needs you",
  };
};

export const coreItems = (machines: ReadonlyArray<FleetMachine>): ReadonlyArray<FooterItem> => [
  fleetItem(machines),
  needsYouItem(machines),
];
