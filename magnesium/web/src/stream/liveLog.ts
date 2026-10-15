import type { HistoryPage, LiveLogItem, LogEntry } from "@magnesium/contracts";

/**
 * The client half of a live log (doc 06): the newest items from the
 * snapshot, new ones as they stream, and older pages merged in front. The
 * client keeps at most `maxItems`; past that it drops the oldest and can page
 * them back in. Items at or below the applied sequence are ignored.
 */

export interface LiveLogState<Item extends LogEntry> {
  readonly sequence: number | null;
  /** Oldest first. */
  readonly items: ReadonlyArray<Item>;
  /** Cursor for the page before `items`; null when nothing older exists. */
  readonly before: number | null;
}

export const DEFAULT_MAX_ITEMS = 1_000;

export const emptyLiveLog = <Item extends LogEntry>(): LiveLogState<Item> => ({
  sequence: null,
  items: [],
  before: null,
});

const bounded = <Item extends LogEntry>(
  items: ReadonlyArray<Item>,
  before: number | null,
  maxItems: number,
): Pick<LiveLogState<Item>, "items" | "before"> => {
  if (items.length <= maxItems) return { items, before };
  const kept = items.slice(items.length - maxItems);
  return { items: kept, before: kept[0]!.sequence };
};

export function applyLiveLogItem<Item extends LogEntry>(
  state: LiveLogState<Item>,
  item: LiveLogItem<Item>,
  maxItems = DEFAULT_MAX_ITEMS,
): LiveLogState<Item> {
  if (item._tag === "snapshot") {
    return { sequence: item.sequence, ...bounded(item.items, item.before, maxItems) };
  }
  if (state.sequence !== null && item.sequence <= state.sequence) return state;
  const last = state.items.at(-1)?.sequence ?? -1;
  const fresh = item.items.filter((entry) => entry.sequence > last);
  if (fresh.length === 0) return { ...state, sequence: item.sequence };
  return {
    sequence: item.sequence,
    ...bounded([...state.items, ...fresh], state.before, maxItems),
  };
}

/** Puts an older page in front. A page that no longer joins the items is ignored. */
export function mergeHistoryPage<Item extends LogEntry>(
  state: LiveLogState<Item>,
  page: HistoryPage<Item>,
): LiveLogState<Item> {
  const first = state.items[0]?.sequence;
  if (first === undefined || state.before === null) return state;
  const older = page.items.filter((entry) => entry.sequence < first);
  if (older.length === 0 && page.before === state.before) return state;
  return { ...state, items: [...older, ...state.items], before: page.before };
}
