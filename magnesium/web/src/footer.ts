import {
  FOOTER_ITEM_ID_PATTERN,
  type FleetMachine,
  type FooterItem,
  footerItemKey,
  MAGNESIUM_WS_METHODS,
  type ThreadCounts,
} from "@magnesium/contracts";

import {
  initialLiveTableView,
  type LiveTableView,
  watchLiveTable,
} from "./stream/watchLiveTable.ts";

/**
 * The footer in the browser (goal 05, doc 14). The hub streams each item's
 * row on `magnesium.footer.items`; the browser half of an item, such as its
 * popover, comes from a registry keyed by the same namespaced id. Magnesium's
 * own items register like an app's will (goal 16). This module holds no React.
 */

export type FooterView = LiveTableView<FooterItem>;
export const initialFooterView: FooterView = initialLiveTableView();

/** Follows the hub's footer items over its route at `socketUrl` until disposed. */
export const watchFooter = (socketUrl: string, onView: (view: FooterView) => void) =>
  watchLiveTable({
    socketUrl,
    subscribe: (client, input) => client[MAGNESIUM_WS_METHODS.footerItems](input),
    key: footerItemKey,
    onView,
  });

export interface FooterRegistration {
  /** `<namespace>:<name>`, the id of the hub's row it shows. */
  readonly id: string;
}

export interface FooterRegistry<Registration extends FooterRegistration> {
  /**
   * Adds an item's browser half and returns what removes it again. An id
   * that is not namespaced, or is already taken, is a mistake and throws.
   */
  readonly register: (registration: Registration) => () => void;
  /** Every registration by id: a new map after each change, the same one otherwise. */
  readonly current: () => ReadonlyMap<string, Registration>;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createFooterRegistry<
  Registration extends FooterRegistration,
>(): FooterRegistry<Registration> {
  let registrations: ReadonlyMap<string, Registration> = new Map();
  const listeners = new Set<() => void>();
  const replace = (next: ReadonlyMap<string, Registration>) => {
    registrations = next;
    for (const listener of listeners) listener();
  };

  return {
    register: (registration) => {
      const { id } = registration;
      if (!FOOTER_ITEM_ID_PATTERN.test(id)) {
        throw new Error(`A footer item's id is "<namespace>:<name>", not "${id}".`);
      }
      if (registrations.has(id)) throw new Error(`The footer item "${id}" is already registered.`);
      replace(new Map(registrations).set(id, registration));
      return () => {
        if (registrations.get(id) !== registration) return;
        const next = new Map(registrations);
        next.delete(id);
        replace(next);
      };
    },
    current: () => registrations,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export interface FooterEntry<Registration> {
  readonly item: FooterItem;
  readonly registration: Registration;
}

export interface FooterLayout<Registration> {
  readonly left: ReadonlyArray<FooterEntry<Registration>>;
  readonly right: ReadonlyArray<FooterEntry<Registration>>;
}

const inOrder = (left: FooterItem, right: FooterItem) =>
  left.order - right.order || left.id.localeCompare(right.id);

/** The bar's order: the left side, then the right, each by `order`, then id. */
const inBarOrder = (left: FooterItem, right: FooterItem) =>
  left.side === right.side ? inOrder(left, right) : left.side === "left" ? -1 : 1;

/**
 * What the bar shows: items the browser has registered and this device has
 * not hidden, on their side, in order. A row nothing registered is left out.
 */
export function layoutFooter<Registration>(
  items: Iterable<FooterItem>,
  registrations: ReadonlyMap<string, Registration>,
  hidden: ReadonlyArray<string>,
): FooterLayout<Registration> {
  const hide = new Set(hidden);
  const left: Array<FooterEntry<Registration>> = [];
  const right: Array<FooterEntry<Registration>> = [];
  for (const item of [...items].toSorted(inOrder)) {
    const registration = registrations.get(item.id);
    if (registration === undefined || hide.has(item.id)) continue;
    (item.side === "left" ? left : right).push({ item, registration });
  }
  return { left, right };
}

export interface FooterToggle {
  readonly id: string;
  readonly label: string;
  readonly shown: boolean;
}

/** Every item the footer settings list, hidden ones included, in the bar's order. */
export function footerToggles(
  items: Iterable<FooterItem>,
  registrations: ReadonlyMap<string, unknown>,
  hidden: ReadonlyArray<string>,
): ReadonlyArray<FooterToggle> {
  const hide = new Set(hidden);
  return [...items]
    .filter((item) => registrations.has(item.id))
    .toSorted(inBarOrder)
    .map((item) => ({ id: item.id, label: item.toggleLabel, shown: !hide.has(item.id) }));
}

/** The device's hidden ids after one switch; the same array when nothing changes. */
export function setFooterItemShown(
  hidden: ReadonlyArray<string>,
  id: string,
  shown: boolean,
): ReadonlyArray<string> {
  const isHidden = hidden.includes(id);
  if (shown) return isHidden ? hidden.filter((other) => other !== id) : hidden;
  return isHidden ? hidden : [...hidden, id];
}

/** A thread as the browser already holds it, reduced to what Needs you lists. */
export interface WaitingThread {
  readonly environmentId: string;
  readonly id: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface WaitingGroup<Thread> {
  readonly machine: FleetMachine;
  /** The waiting threads this browser knows on that machine, at most the limit. */
  readonly threads: ReadonlyArray<Thread>;
  /** How many more it knows past the limit. */
  readonly more: number;
}

/**
 * The machines in Needs you: those with something waiting, then those whose
 * counts the hub can't see, each with the waiting threads the browser
 * already holds for it. `machines` comes in Fleet's order and keeps it.
 */
export function waitingByMachine<Thread extends WaitingThread>(
  machines: ReadonlyArray<FleetMachine>,
  threads: ReadonlyArray<Thread>,
  limit = 5,
): ReadonlyArray<WaitingGroup<Thread>> {
  const waiting = new Map<string, Array<Thread>>();
  for (const thread of threads) {
    if (!thread.hasPendingApprovals && !thread.hasPendingUserInput) continue;
    const known = waiting.get(thread.environmentId);
    if (known === undefined) waiting.set(thread.environmentId, [thread]);
    else known.push(thread);
  }
  const groupOf = (machine: FleetMachine): WaitingGroup<Thread> => {
    const known =
      machine.threads === null || machine.environmentId === null
        ? []
        : (waiting.get(machine.environmentId) ?? []);
    return { machine, threads: known.slice(0, limit), more: Math.max(0, known.length - limit) };
  };
  return [
    ...machines.filter((machine) => (machine.threads?.waiting ?? 0) > 0),
    ...machines.filter((machine) => machine.threads === null),
  ].map(groupOf);
}

/** What waits on you on one machine; unknown counts are said to be unknown. */
export function describeWaiting(threads: ThreadCounts | null): string {
  if (threads === null) return "Not counted, not connected";
  if (threads.waiting === 0) return "Nothing waiting";
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [
    threads.approvals > 0 ? plural(threads.approvals, "approval") : null,
    threads.questions > 0 ? plural(threads.questions, "question") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
