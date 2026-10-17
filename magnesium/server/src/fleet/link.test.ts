import type { ServerStatus, ServerStatusItem } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  backoffDelay,
  DEFAULT_LINK_TIMINGS,
  LinkDialError,
  type LinkDown,
  type LinkTimings,
  runLink,
} from "./link.ts";

class Dropped extends Schema.TaggedError<Dropped>()("Dropped", {}) {}

const timings: LinkTimings = { ...DEFAULT_LINK_TIMINGS, jitter: 0 };

const status = (waiting: number): ServerStatus => ({
  environmentId: EnvironmentId.make("env-cpu-host-1"),
  label: "cpu-host-1",
  serverVersion: "0.0.45",
  release: "f0d9e1703a",
  deployment: "pod",
  node: "node-b",
  workload: null,
  role: null,
  startedAt: "2026-10-15T00:00:00.000Z",
  threads: { total: 3, running: 1, waiting, approvals: waiting, questions: 0 },
});

/** A machine the link dials: up or down, answering pings or silent, and droppable. */
const makeMachine = Effect.sync(() => {
  const state = { up: true, silent: false, dials: 0 };
  let current: Queue.Queue<ServerStatusItem, Dropped> | null = null;
  const dial = Effect.gen(function* () {
    state.dials += 1;
    if (!state.up) {
      return yield* new LinkDialError({ link: "offline", detail: "It did not answer." });
    }
    const items = yield* Queue.unbounded<ServerStatusItem, Dropped>();
    yield* Queue.offer(items, { _tag: "snapshot", sequence: 1, rows: [status(0)] });
    current = items;
    return {
      status: Stream.fromQueue(items),
      ping: Effect.suspend(() => (state.silent ? Effect.never : Effect.void)),
    };
  });
  return {
    state,
    dial,
    send: (item: ServerStatusItem) =>
      Effect.suspend(() => (current === null ? Effect.void : Queue.offer(current, item))),
    drop: Effect.suspend(() =>
      current === null ? Effect.void : Queue.fail(current, new Dropped()),
    ),
  };
});

const startLink = Effect.gen(function* () {
  const machine = yield* makeMachine;
  const statuses: ServerStatus[] = [];
  const downs: LinkDown[] = [];
  const wake = yield* Queue.sliding<void>(1);
  yield* Effect.forkScoped(
    runLink({
      dial: machine.dial,
      handlers: {
        onStatus: (row) => Effect.sync(() => void statuses.push(row)),
        onDown: (down) => Effect.sync(() => void downs.push(down)),
      },
      wake,
      timings,
    }),
  );
  // Let the first dial land.
  yield* TestClock.adjust("1 millis");
  return { machine, statuses, downs, wake };
});

describe("a machine link", () => {
  it.effect("follows the machine's status, and says when the link drops", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      expect(link.statuses.map((row) => row.threads.waiting)).toEqual([0]);
      yield* link.machine.send({
        _tag: "changes",
        sequence: 2,
        upserts: [status(1)],
        removals: [],
      });
      yield* TestClock.adjust("1 millis");
      expect(link.statuses.map((row) => row.threads.waiting)).toEqual([0, 1]);

      link.machine.state.up = false;
      yield* link.machine.drop;
      yield* TestClock.adjust("1 millis");
      expect(link.downs).toHaveLength(1);
      expect(link.downs[0]).toMatchObject({ link: "offline", detail: "The connection dropped." });
      expect(link.downs[0]!.lastSeenAt).not.toBeNull();
    }),
  );

  it.effect("redials a down machine with growing waits, capped", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      link.machine.state.up = false;
      yield* link.machine.drop;
      // Waits of 1, 2, 4, 8, 15 and 15 seconds: six more dials in 45 seconds.
      yield* TestClock.adjust("45 seconds");
      expect(link.machine.state.dials).toBe(1 + 6);
      expect(backoffDelay(timings, 10)).toEqual(Duration.seconds(15));
    }),
  );

  it.effect("redials at once when asked, instead of waiting out the backoff", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      link.machine.state.up = false;
      yield* link.machine.drop;
      yield* TestClock.adjust("8 seconds");
      const before = link.machine.state.dials;
      link.machine.state.up = true;
      yield* Queue.offer(link.wake, undefined);
      yield* TestClock.adjust("1 millis");
      expect(link.machine.state.dials).toBe(before + 1);
      expect(link.statuses.length).toBe(2);
    }),
  );

  it.effect("notices a machine that stops answering within five seconds", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      link.machine.state.silent = true;
      yield* TestClock.adjust("5 seconds");
      expect(link.downs).toHaveLength(1);
      expect(link.downs[0]!.detail).toBe("It stopped answering.");
    }),
  );

  it.effect("backs off from a flapping machine, so it costs a few updates a minute", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      // The machine comes up and drops again a moment later, for a minute.
      for (let second = 0; second < 60; second++) {
        yield* link.machine.drop;
        yield* TestClock.adjust("1 second");
      }
      const transitions = link.statuses.length + link.downs.length;
      expect(link.machine.state.dials).toBeGreaterThanOrEqual(5);
      expect(link.machine.state.dials).toBeLessThanOrEqual(10);
      expect(transitions).toBeGreaterThanOrEqual(10);
      expect(transitions).toBeLessThanOrEqual(20);
    }),
  );

  it.effect("goes back to the shortest wait after a link that held", () =>
    Effect.gen(function* () {
      const link = yield* startLink;
      // Two quick drops push the next wait to 4 seconds...
      yield* link.machine.drop;
      yield* TestClock.adjust("1 second");
      yield* link.machine.drop;
      yield* TestClock.adjust("2 seconds");
      // ...then the link holds for a minute, and drops.
      yield* TestClock.adjust("60 seconds");
      const dials = link.machine.state.dials;
      yield* link.machine.drop;
      yield* TestClock.adjust("1 second");
      expect(link.machine.state.dials).toBe(dials + 1);
    }),
  );

  it.effect("tells no access apart from offline, and retries it slowly", () =>
    Effect.gen(function* () {
      const downs: LinkDown[] = [];
      let dials = 0;
      const wake = yield* Queue.sliding<void>(1);
      yield* Effect.forkScoped(
        runLink({
          dial: Effect.suspend(() => {
            dials += 1;
            return Effect.fail(
              new LinkDialError({ link: "no-access", detail: "The hub has no access to it yet." }),
            );
          }),
          handlers: {
            onStatus: () => Effect.void,
            onDown: (down) => Effect.sync(() => void downs.push(down)),
          },
          wake,
          timings,
        }),
      );
      yield* TestClock.adjust("59 seconds");
      expect(downs[0]).toMatchObject({ link: "no-access", lastSeenAt: null });
      expect(dials).toBe(2);
    }),
  );
});
