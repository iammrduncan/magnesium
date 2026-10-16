import {
  FOOTER_ITEM_ID_PATTERN,
  type FooterItem,
  footerItemKey,
  MAGNESIUM_WS_METHODS,
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
