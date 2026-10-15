// @effect-diagnostics preferSchemaOverJson:off - the tests measure bytes on the wire as JSON.
import type { LiveLogItem, LiveTableItem } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as LiveLog from "./LiveLog.ts";
import * as LiveTable from "./LiveTable.ts";

interface Row {
  readonly name: string;
  readonly value: number;
}

interface Entry {
  readonly sequence: number;
  readonly text: string;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Runs a stream into a queue for the rest of the test. */
const collect = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<A>();
    yield* Effect.forkScoped(stream.pipe(Stream.runForEach((item) => Queue.offer(items, item))));
    return items;
  });

const tableOf = (rows: number, replay?: number) =>
  Effect.gen(function* () {
    const table = yield* LiveTable.make<Row>({
      key: (row) => row.name,
      ...(replay === undefined ? {} : { replay }),
    });
    for (let index = 0; index < rows; index++) {
      yield* table.set({ name: `row-${index}`, value: 0 });
    }
    return table;
  });

describe("LiveTable", () => {
  it.effect("sends a snapshot, then one coalesced change with the newest row per key", () =>
    Effect.gen(function* () {
      const table = yield* tableOf(2);
      const items = yield* collect(table.subscribe({}));
      expect(yield* Queue.take(items)).toEqual({
        _tag: "snapshot",
        sequence: 2,
        rows: [
          { name: "row-0", value: 0 },
          { name: "row-1", value: 0 },
        ],
      });

      for (let value = 1; value <= 100; value++) yield* table.set({ name: "row-0", value });
      yield* table.remove("row-1");
      yield* TestClock.adjust("50 millis");

      expect(yield* Queue.take(items)).toEqual({
        _tag: "changes",
        sequence: 103,
        upserts: [{ name: "row-0", value: 100 }],
        removals: ["row-1"],
      });
      expect(yield* Queue.size(items)).toBe(0);
    }),
  );

  it.effect("ignores a row equal to the one it holds", () =>
    Effect.gen(function* () {
      const table = yield* tableOf(1);
      yield* table.set({ name: "row-0", value: 0 });
      expect((yield* table.snapshot).sequence).toBe(1);
    }),
  );

  it.effect("resumes with only the keys that changed since the client's sequence", () =>
    Effect.gen(function* () {
      const table = yield* tableOf(200);
      const before = (yield* table.snapshot).sequence;
      yield* table.set({ name: "row-7", value: 1 });

      const items = yield* collect(table.subscribe({ afterSequence: before }));
      const resumed = yield* Queue.take(items);
      expect(resumed).toEqual({
        _tag: "changes",
        sequence: before + 1,
        upserts: [{ name: "row-7", value: 1 }],
        removals: [],
      });

      // Byte budget: a resume carries the changed row, never the table.
      const snapshot: LiveTableItem<Row> = { _tag: "snapshot", ...(yield* table.snapshot) };
      expect(bytes(resumed)).toBeLessThan(256);
      expect(bytes(snapshot)).toBeGreaterThan(5_000);
    }),
  );

  it.effect(
    "tells a client that missed nothing so, and sends a snapshot when it cannot resume",
    () =>
      Effect.gen(function* () {
        const table = yield* tableOf(3, 4);
        const now = (yield* table.snapshot).sequence;
        const current = yield* collect(table.subscribe({ afterSequence: now }));
        expect(yield* Queue.take(current)).toEqual({
          _tag: "changes",
          sequence: now,
          upserts: [],
          removals: [],
        });

        for (let value = 1; value <= 5; value++) yield* table.set({ name: "row-0", value });
        // Five changes since `now`; the table remembers four.
        const stale = yield* collect(table.subscribe({ afterSequence: now }));
        expect((yield* Queue.take(stale))._tag).toBe("snapshot");
        // A sequence from the future (another server, or a reset one) also gets a snapshot.
        const future = yield* collect(table.subscribe({ afterSequence: now + 1_000 }));
        expect((yield* Queue.take(future))._tag).toBe("snapshot");
      }),
  );

  it.effect("sends a row that flaps for a second at most once per coalescing window", () =>
    Effect.gen(function* () {
      const table = yield* tableOf(1);
      const items = yield* collect(table.subscribe({}));
      yield* Queue.take(items);
      for (let tick = 1; tick <= 200; tick++) {
        yield* table.set({ name: "row-0", value: tick % 2 });
        yield* TestClock.adjust("5 millis");
      }
      yield* TestClock.adjust("50 millis");
      const updates = yield* Queue.takeAll(items);
      expect(updates.length).toBeGreaterThanOrEqual(10);
      expect(updates.length).toBeLessThanOrEqual(21);
      expect(updates.reduce((sum, item) => sum + bytes(item), 0)).toBeLessThan(21 * 128);
    }),
  );
});

const logOf = (entries: number, options: Partial<LiveLog.LiveLogOptions<Entry, string>> = {}) =>
  Effect.gen(function* () {
    const log = yield* LiveLog.make<Entry, string>({
      store: LiveLog.memoryStore((text, sequence) => ({ sequence, text })),
      ...options,
    });
    for (let index = 1; index <= entries; index++) yield* log.append(`entry ${index}`);
    return log;
  });

const sequences = (items: ReadonlyArray<Entry>) => items.map((item) => item.sequence);

describe("LiveLog", () => {
  it.effect("opens on the newest items and pages back through all of them once", () =>
    Effect.gen(function* () {
      const log = yield* logOf(120, { snapshotLimit: 50, pageLimit: 50 });
      const snapshot = yield* log.snapshot;
      expect(sequences(snapshot.items)).toEqual(Array.from({ length: 50 }, (_, i) => 71 + i));
      expect(snapshot.sequence).toBe(120);
      expect(snapshot.before).toBe(71);

      const seen = [...sequences(snapshot.items)];
      let before = snapshot.before;
      while (before !== null) {
        const page = yield* log.history({ before });
        seen.unshift(...sequences(page.items));
        before = page.before;
      }
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    }),
  );

  it.effect("keeps every snapshot and page under its byte budget", () =>
    Effect.gen(function* () {
      const big = "x".repeat(2_000);
      const log = yield* LiveLog.make<Entry, string>({
        store: LiveLog.memoryStore((text, sequence) => ({ sequence, text })),
        maxBytes: 16 * 1024,
      });
      for (let index = 0; index < 200; index++) yield* log.append(big);

      const snapshot = yield* log.snapshot;
      expect(bytes(snapshot)).toBeLessThan(17 * 1024);
      expect(snapshot.items.length).toBeGreaterThan(0);
      expect(snapshot.before).toBe(snapshot.items[0]!.sequence);

      const page = yield* log.history({ before: snapshot.before!, limit: 200 });
      expect(bytes(page)).toBeLessThan(17 * 1024);
      expect(page.items.at(-1)!.sequence).toBe(snapshot.before! - 1);
    }),
  );

  it.effect("streams appends coalesced, and loses none in a burst", () =>
    Effect.gen(function* () {
      const log = yield* logOf(3);
      const items = yield* collect(log.subscribe({}));
      const first = yield* Queue.take(items);
      expect(first._tag).toBe("snapshot");

      for (let index = 4; index <= 500; index++) yield* log.append(`entry ${index}`);
      const received: Entry[] = [];
      while (received.length < 497) {
        yield* TestClock.adjust("50 millis");
        for (const item of yield* Queue.takeAll(items)) {
          expect(item._tag).toBe("appended");
          received.push(...(item as Extract<LiveLogItem<Entry>, { _tag: "appended" }>).items);
        }
      }
      expect(sequences(received)).toEqual(Array.from({ length: 497 }, (_, i) => i + 4));
    }),
  );

  it.effect("resumes with what a client missed, or a snapshot when that is too much", () =>
    Effect.gen(function* () {
      const log = yield* logOf(10, { replay: 5 });
      const near = yield* collect(log.subscribe({ afterSequence: 7 }));
      expect(yield* Queue.take(near)).toEqual({
        _tag: "appended",
        sequence: 10,
        items: [8, 9, 10].map((sequence) => ({ sequence, text: `entry ${sequence}` })),
      });
      const far = yield* collect(log.subscribe({ afterSequence: 2 }));
      expect((yield* Queue.take(far))._tag).toBe("snapshot");
      const caughtUp = yield* collect(log.subscribe({ afterSequence: 10 }));
      expect(yield* Queue.take(caughtUp)).toEqual({ _tag: "appended", sequence: 10, items: [] });
    }),
  );
});
