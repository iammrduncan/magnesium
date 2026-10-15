import type {
  HistoryPage,
  LiveLogItem,
  LogEntry,
  StreamHistoryInput,
  StreamSubscribeInput,
} from "@magnesium/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { DEFAULT_COALESCE, DEFAULT_REPLAY } from "./LiveTable.ts";

/**
 * A log that only grows, streamed the way doc 06 describes: a bounded snapshot
 * of the newest items with a cursor to page back through `history`, then new
 * items coalesced over about 50 ms. A subscriber keeps only its cursor; each
 * wake reads what follows it from the store, so nothing is dropped and a slow
 * client never piles up memory. A client that reconnects with its last
 * sequence gets just what it missed, when that is a short list.
 */

export const DEFAULT_SNAPSHOT_LIMIT = 50;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
/** Each snapshot and history page stays under this many bytes of JSON. */
export const DEFAULT_MAX_BYTES = 64 * 1024;

/** Where a log keeps its items. Sequences rise; reads return items oldest first. */
export interface LogStore<Item extends LogEntry, Input> {
  /** Stores the items, in order, and returns them with their sequences. */
  readonly append: (inputs: ReadonlyArray<Input>) => Effect.Effect<ReadonlyArray<Item>>;
  /** The newest `limit` items. */
  readonly latest: (limit: number) => Effect.Effect<ReadonlyArray<Item>>;
  /** The newest `limit` items before `sequence`. */
  readonly before: (sequence: number, limit: number) => Effect.Effect<ReadonlyArray<Item>>;
  /** The first `limit` items after `sequence`. */
  readonly after: (sequence: number, limit: number) => Effect.Effect<ReadonlyArray<Item>>;
  /** The newest sequence; 0 when the log is empty. */
  readonly head: Effect.Effect<number>;
}

export interface LiveLogOptions<Item extends LogEntry, Input> {
  readonly store: LogStore<Item, Input>;
  readonly snapshotLimit?: number;
  readonly pageLimit?: number;
  readonly maxBytes?: number;
  readonly replay?: number;
  readonly coalesce?: Duration.Input;
  /** An item's size on the wire; its JSON length by default. */
  readonly size?: (item: Item) => number;
}

export interface LiveLog<Item extends LogEntry, Input> {
  readonly append: (input: Input) => Effect.Effect<Item>;
  readonly snapshot: Effect.Effect<Extract<LiveLogItem<Item>, { readonly _tag: "snapshot" }>>;
  readonly history: (input: StreamHistoryInput) => Effect.Effect<HistoryPage<Item>>;
  readonly subscribe: (input: StreamSubscribeInput) => Stream.Stream<LiveLogItem<Item>>;
}

const jsonSize = (value: unknown) => JSON.stringify(value).length;

/**
 * The newest items that fit in `maxBytes`, always at least one so a client
 * moves forward. `trimmed` says whether older items were left out.
 */
export const takeNewestWithin = <Item>(
  items: ReadonlyArray<Item>,
  maxBytes: number,
  size: (item: Item) => number,
): { readonly items: ReadonlyArray<Item>; readonly trimmed: boolean } => {
  let bytes = 0;
  let start = items.length;
  while (start > 0) {
    const next = bytes + size(items[start - 1]!);
    if (next > maxBytes && start < items.length) break;
    bytes = next;
    start -= 1;
  }
  return { items: start === 0 ? items : items.slice(start), trimmed: start > 0 };
};

/** The oldest items that fit in `maxBytes`, always at least one. */
const takeOldestWithin = <Item>(
  items: ReadonlyArray<Item>,
  maxBytes: number,
  size: (item: Item) => number,
): ReadonlyArray<Item> => {
  let bytes = 0;
  let end = 0;
  while (end < items.length) {
    const next = bytes + size(items[end]!);
    if (next > maxBytes && end > 0) break;
    bytes = next;
    end += 1;
  }
  return end === items.length ? items : items.slice(0, end);
};

export const make = <Item extends LogEntry, Input>(
  options: LiveLogOptions<Item, Input>,
): Effect.Effect<LiveLog<Item, Input>> =>
  Effect.sync(() => {
    const { store } = options;
    const snapshotLimit = options.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT;
    const pageLimit = Math.min(options.pageLimit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const replay = options.replay ?? DEFAULT_REPLAY;
    const coalesce = Duration.fromInputUnsafe(options.coalesce ?? DEFAULT_COALESCE);
    const size = options.size ?? jsonSize;
    const wakes = new Set<Queue.Queue<void>>();

    /** A page of `limit` items read with one extra, to know whether more lie before it. */
    const page = (read: ReadonlyArray<Item>, limit: number): HistoryPage<Item> => {
      const more = read.length > limit;
      const window = more ? read.slice(read.length - limit) : read;
      const fitted = takeNewestWithin(window, maxBytes, size);
      const before =
        (more || fitted.trimmed) && fitted.items.length > 0 ? fitted.items[0]!.sequence : null;
      return { items: fitted.items, before };
    };

    const snapshot = store.latest(snapshotLimit + 1).pipe(
      Effect.map((read) => {
        const { items, before } = page(read, snapshotLimit);
        return {
          _tag: "snapshot" as const,
          // The client has everything up to the newest item it was given.
          sequence: items.at(-1)?.sequence ?? 0,
          items,
          before,
        };
      }),
    );

    const history = (input: StreamHistoryInput) => {
      const limit = Math.max(1, Math.min(input.limit ?? pageLimit, pageLimit));
      return store.before(input.before, limit + 1).pipe(Effect.map((read) => page(read, limit)));
    };

    const append = (input: Input) =>
      store.append([input]).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const wake of wakes) Queue.offerUnsafe(wake, undefined);
          }),
        ),
        Effect.map((items) => items[0]!),
      );

    /** Only what a resuming client missed, if that is a short list; otherwise a snapshot. */
    const head = (afterSequence: number | undefined) =>
      Effect.gen(function* () {
        if (afterSequence === undefined) return yield* snapshot;
        if (afterSequence > (yield* store.head)) return yield* snapshot;
        const missed = yield* store.after(afterSequence, replay + 1);
        const total = missed.reduce((sum, item) => sum + size(item), 0);
        if (missed.length > replay || total > maxBytes) return yield* snapshot;
        return {
          _tag: "appended" as const,
          sequence: missed.at(-1)?.sequence ?? afterSequence,
          items: missed,
        };
      });

    const subscribe = (input: StreamSubscribeInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const wake = yield* Queue.sliding<void>(1);
          // Listen before reading, so an append during the read still wakes us.
          yield* Effect.acquireRelease(
            Effect.sync(() => wakes.add(wake)),
            () => Effect.sync(() => wakes.delete(wake)),
          );
          const first: LiveLogItem<Item> = yield* head(input.afterSequence);
          let cursor = first.sequence;
          const pull = Effect.suspend(() => store.after(cursor, pageLimit)).pipe(
            Effect.map((read): LiveLogItem<Item> | null => {
              // The oldest that fit go now; the rest on the next wake.
              const sent = takeOldestWithin(read, maxBytes, size);
              if (sent.length === 0) return null;
              cursor = sent.at(-1)!.sequence;
              if (sent.length < read.length || read.length === pageLimit) {
                Queue.offerUnsafe(wake, undefined);
              }
              return { _tag: "appended", sequence: cursor, items: sent };
            }),
          );
          const live = Stream.fromQueue(wake).pipe(
            Stream.mapEffect(() => Effect.sleep(coalesce).pipe(Effect.andThen(pull))),
            Stream.filter((item): item is LiveLogItem<Item> => item !== null),
          );
          return Stream.concat(Stream.make(first), live);
        }),
      );

    return { append, snapshot, history, subscribe } satisfies LiveLog<Item, Input>;
  });

/** A log kept in memory, for tests and logs that need not outlive the process. */
export const memoryStore = <Item extends LogEntry, Input>(
  build: (input: Input, sequence: number) => Item,
  capacity = 10_000,
): LogStore<Item, Input> => {
  const items: Item[] = [];
  let sequence = 0;
  return {
    append: (inputs) =>
      Effect.sync(() => {
        const added = inputs.map((input) => build(input, ++sequence));
        items.push(...added);
        if (items.length > capacity) items.splice(0, items.length - capacity);
        return added;
      }),
    latest: (limit) => Effect.sync(() => items.slice(Math.max(0, items.length - limit))),
    before: (before, limit) =>
      Effect.sync(() => {
        const end = items.findIndex((item) => item.sequence >= before);
        const stop = end === -1 ? items.length : end;
        return items.slice(Math.max(0, stop - limit), stop);
      }),
    after: (after, limit) =>
      Effect.sync(() => items.filter((item) => item.sequence > after).slice(0, limit)),
    head: Effect.sync(() => sequence),
  };
};
