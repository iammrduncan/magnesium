import { NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The wire shapes of Magnesium's streams (doc 06). Every stream on our route is
 * one of two kinds, and both start with a bounded snapshot that carries a
 * sequence number, so a client that reconnects asks only for what it missed.
 *
 * - A **table** is a small keyed set that changes in place: the machines in
 *   Fleet, a server's status. Changes arrive coalesced, newest row per key.
 * - A **log** only grows: room messages, link events. The snapshot holds the
 *   newest items; older ones come a page at a time through `history`.
 */

/** Subscribe from scratch, or after the last sequence the client applied. */
export const StreamSubscribeInput = Schema.Struct({
  afterSequence: Schema.optionalKey(NonNegativeInt),
});
export type StreamSubscribeInput = typeof StreamSubscribeInput.Type;

/**
 * - `snapshot`: every row; replaces what the client holds.
 * - `changes`: rows that changed after the client's sequence, and keys that
 *   went away. Empty when a resuming client missed nothing.
 */
export const liveTableItem = <Row extends Schema.Top>(row: Row) =>
  Schema.Union([
    Schema.TaggedStruct("snapshot", {
      sequence: NonNegativeInt,
      rows: Schema.Array(row),
    }),
    Schema.TaggedStruct("changes", {
      sequence: NonNegativeInt,
      upserts: Schema.Array(row),
      removals: Schema.Array(Schema.String),
    }),
  ]);

export type LiveTableItem<Row> =
  | { readonly _tag: "snapshot"; readonly sequence: number; readonly rows: ReadonlyArray<Row> }
  | {
      readonly _tag: "changes";
      readonly sequence: number;
      readonly upserts: ReadonlyArray<Row>;
      readonly removals: ReadonlyArray<string>;
    };

/** Every log item carries its own sequence; it is also the history cursor. */
export interface LogEntry {
  readonly sequence: number;
}

/**
 * - `snapshot`: the newest items, oldest first, with the cursor for the page
 *   before them (null when there is nothing older).
 * - `appended`: items after the client's sequence, oldest first.
 */
export const liveLogItem = <Item extends Schema.Top>(item: Item) =>
  Schema.Union([
    Schema.TaggedStruct("snapshot", {
      sequence: NonNegativeInt,
      items: Schema.Array(item),
      before: Schema.NullOr(NonNegativeInt),
    }),
    Schema.TaggedStruct("appended", {
      sequence: NonNegativeInt,
      items: Schema.Array(item),
    }),
  ]);

export type LiveLogItem<Item> =
  | {
      readonly _tag: "snapshot";
      readonly sequence: number;
      readonly items: ReadonlyArray<Item>;
      readonly before: number | null;
    }
  | { readonly _tag: "appended"; readonly sequence: number; readonly items: ReadonlyArray<Item> };

/** One page of a log's older items, the ones before `before`. */
export const StreamHistoryInput = Schema.Struct({
  before: NonNegativeInt,
  limit: Schema.optionalKey(NonNegativeInt),
});
export type StreamHistoryInput = typeof StreamHistoryInput.Type;

export const historyPage = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({
    items: Schema.Array(item),
    before: Schema.NullOr(NonNegativeInt),
  });

export interface HistoryPage<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly before: number | null;
}
