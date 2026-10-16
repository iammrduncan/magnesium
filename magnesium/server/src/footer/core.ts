import type { FleetMachine, FooterItem, HomeSummary } from "@magnesium/contracts";

/**
 * Magnesium's own footer items: Machines from Fleet's rows (goal 05), Needs
 * you from Home's summary (goal 06). They are plain rows like any app's, so
 * the browser treats every item the same way.
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

/** "a, b and c". */
const listOf = (parts: ReadonlyArray<string>) =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/**
 * How many things wait on you, from Home's summary: the same count Home shows.
 * A machine the hub can't see is named in the detail, never counted as zero.
 */
export const needsYouItem = (summary: HomeSummary): FooterItem => {
  const { counts, unseen } = summary;
  const kinds = [
    counts.approval > 0 ? count(counts.approval, "approval") : null,
    counts.question > 0 ? count(counts.question, "question") : null,
    counts.plan > 0 ? `${count(counts.plan, "plan")} ready` : null,
    counts.failure > 0 ? count(counts.failure, "failure") : null,
  ].filter((kind) => kind !== null);
  const notes = [
    counts.total > 0
      ? `${listOf(kinds)}.`
      : unseen.length > 0
        ? "Nothing waits on you on the machines the hub can see."
        : "Nothing waits on you.",
  ];
  if (unseen.length > 0) notes.push(`Not counted, not connected: ${unseen.join(", ")}.`);
  return {
    id: CORE_NEEDS_YOU_ITEM_ID,
    side: "left",
    order: 20,
    label: `Needs you ${counts.total}`,
    detail: notes.join(" "),
    tone: counts.total > 0 ? "warning" : "neutral",
    toggleLabel: "Needs you",
  };
};

export const coreItems = (
  machines: ReadonlyArray<FleetMachine>,
  summary: HomeSummary,
): ReadonlyArray<FooterItem> => [fleetItem(machines), needsYouItem(summary)];
