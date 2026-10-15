import type { LiveTableItem, StreamSubscribeInput } from "@magnesium/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * A small keyed set that streams its changes (doc 06): Fleet's machines, a
 * server's status, later Home's items. Subscribers get a snapshot with a
 * sequence, then changes coalesced over about 50 ms, newest row per key, so a
 * row that changes a hundred times in a window costs one update. A subscriber
 * holds a set of dirty keys, not a queue of changes, so a slow client never
 * piles up memory. A client that reconnects with the last sequence it applied
 * gets only the keys that changed since, while the table still remembers them.
 *
 * Anything that only grows belongs in a `LiveLog`, which pages its history.
 */

export const DEFAULT_COALESCE = Duration.millis(50);
export const DEFAULT_MAX_ROWS = 500;
/** Changes remembered for resume (doc 06: replay at most 128 events). */
export const DEFAULT_REPLAY = 128;

export interface LiveTableOptions<Row> {
  readonly key: (row: Row) => string;
  /** New keys past this are refused, with a warning. */
  readonly maxRows?: number;
  readonly coalesce?: Duration.Input;
  readonly replay?: number;
  /** Rows equal to the current one are not a change. Structural by default. */
  readonly equals?: (left: Row, right: Row) => boolean;
}

export interface LiveTable<Row> {
  /** Insert or replace a row; a no-op when it equals the current one. */
  readonly set: (row: Row) => Effect.Effect<void>;
  readonly remove: (key: string) => Effect.Effect<void>;
  readonly get: (key: string) => Effect.Effect<Option.Option<Row>>;
  readonly snapshot: Effect.Effect<{
    readonly sequence: number;
    readonly rows: ReadonlyArray<Row>;
  }>;
  readonly subscribe: (input: StreamSubscribeInput) => Stream.Stream<LiveTableItem<Row>>;
}

interface Subscriber {
  readonly dirty: Set<string>;
  readonly wake: Queue.Queue<void>;
}

export const make = <Row>(options: LiveTableOptions<Row>): Effect.Effect<LiveTable<Row>> =>
  Effect.sync(() => {
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    const replay = options.replay ?? DEFAULT_REPLAY;
    const coalesce = Duration.fromInputUnsafe(options.coalesce ?? DEFAULT_COALESCE);
    const equals = options.equals ?? Equal.equals;

    const rows = new Map<string, Row>();
    // Sequence of each recent change, oldest first, at most `replay` long.
    const recent: Array<{ readonly sequence: number; readonly key: string }> = [];
    const subscribers = new Set<Subscriber>();
    let sequence = 0;
    let warnedFull = false;

    const changed = (key: string) => {
      sequence += 1;
      recent.push({ sequence, key });
      if (recent.length > replay) recent.shift();
      for (const subscriber of subscribers) {
        subscriber.dirty.add(key);
        Queue.offerUnsafe(subscriber.wake, undefined);
      }
    };

    const set = (row: Row) =>
      Effect.suspend(() => {
        const key = options.key(row);
        const current = rows.get(key);
        if (current !== undefined && equals(current, row)) return Effect.void;
        if (current === undefined && rows.size >= maxRows) {
          if (warnedFull) return Effect.void;
          warnedFull = true;
          return Effect.logWarning("A live table is full; new rows are dropped.", { maxRows });
        }
        rows.set(key, row);
        changed(key);
        return Effect.void;
      });

    const remove = (key: string) =>
      Effect.sync(() => {
        if (rows.delete(key)) changed(key);
      });

    const changesFor = (keys: Iterable<string>): LiveTableItem<Row> => {
      const upserts: Row[] = [];
      const removals: string[] = [];
      for (const key of keys) {
        const row = rows.get(key);
        if (row === undefined) removals.push(key);
        else upserts.push(row);
      }
      return { _tag: "changes", sequence, upserts, removals };
    };

    const snapshotItem = (): LiveTableItem<Row> => ({
      _tag: "snapshot",
      sequence,
      rows: [...rows.values()],
    });

    /** What a new subscriber needs first: only what it missed, if the table still knows. */
    const head = (afterSequence: number | undefined): LiveTableItem<Row> => {
      if (afterSequence === undefined || afterSequence > sequence) return snapshotItem();
      if (afterSequence === sequence) return changesFor([]);
      const oldest = recent[0]?.sequence ?? sequence + 1;
      if (afterSequence + 1 < oldest) return snapshotItem();
      const keys = new Set<string>();
      for (const change of recent) if (change.sequence > afterSequence) keys.add(change.key);
      return changesFor(keys);
    };

    const subscribe = (input: StreamSubscribeInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscriber: Subscriber = {
            dirty: new Set(),
            wake: yield* Queue.sliding<void>(1),
          };
          // Register and read the head in one step, so no change falls between them.
          const first = yield* Effect.acquireRelease(
            Effect.sync(() => {
              subscribers.add(subscriber);
              return head(input.afterSequence);
            }),
            () => Effect.sync(() => subscribers.delete(subscriber)),
          );
          const drain = Effect.sync((): LiveTableItem<Row> | null => {
            if (subscriber.dirty.size === 0) return null;
            const item = changesFor(subscriber.dirty);
            subscriber.dirty.clear();
            return item;
          });
          const live = Stream.fromQueue(subscriber.wake).pipe(
            Stream.mapEffect(() => Effect.sleep(coalesce).pipe(Effect.andThen(drain))),
            Stream.filter((item): item is LiveTableItem<Row> => item !== null),
          );
          return Stream.concat(Stream.make(first), live);
        }),
      );

    return {
      set,
      remove,
      get: (key) => Effect.sync(() => Option.fromNullishOr(rows.get(key))),
      snapshot: Effect.sync(() => ({ sequence, rows: [...rows.values()] })),
      subscribe,
    } satisfies LiveTable<Row>;
  });
