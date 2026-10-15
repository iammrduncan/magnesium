import type { LiveTableItem } from "@magnesium/contracts";
import * as Equal from "effect/Equal";

/**
 * The client half of a live table (doc 06). Applying an item returns the same
 * state object when nothing changed, and keeps each unchanged row's object, so
 * React skips what did not move. Items at or below the applied sequence are
 * ignored, so a resumed stream that overlaps is harmless.
 */

export interface LiveTableState<Row> {
  /** Null until the first item; resume from it after a reconnect. */
  readonly sequence: number | null;
  readonly rows: ReadonlyMap<string, Row>;
}

export const emptyLiveTable = <Row>(): LiveTableState<Row> => ({ sequence: null, rows: new Map() });

/** Pass when subscribing, to resume where the client left off. */
export const resumeFrom = (state: { readonly sequence: number | null }) =>
  state.sequence === null ? {} : { afterSequence: state.sequence };

const keep = <Row>(previous: Row | undefined, next: Row): Row =>
  previous !== undefined && Equal.equals(previous, next) ? previous : next;

export function applyLiveTableItem<Row>(
  state: LiveTableState<Row>,
  item: LiveTableItem<Row>,
  key: (row: Row) => string,
): LiveTableState<Row> {
  if (item._tag === "snapshot") {
    const rows = new Map<string, Row>();
    let same = state.rows.size === item.rows.length;
    for (const row of item.rows) {
      const id = key(row);
      const previous = state.rows.get(id);
      const kept = keep(previous, row);
      if (kept !== previous) same = false;
      rows.set(id, kept);
    }
    if (same && state.sequence === item.sequence) return state;
    return { sequence: item.sequence, rows: same ? state.rows : rows };
  }

  if (state.sequence !== null && item.sequence <= state.sequence) return state;
  let rows: Map<string, Row> | null = null;
  const edit = () => (rows ??= new Map(state.rows));
  for (const row of item.upserts) {
    const id = key(row);
    const previous = state.rows.get(id);
    const kept = keep(previous, row);
    if (kept !== previous) edit().set(id, kept);
  }
  for (const id of item.removals) {
    if (state.rows.has(id)) edit().delete(id);
  }
  return { sequence: item.sequence, rows: rows ?? state.rows };
}
