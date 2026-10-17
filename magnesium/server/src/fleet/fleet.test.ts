// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - the test rewrites the hub's config and times what the browser sees.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type FleetMachine,
  FleetMachinesItem,
  fleetMachineKey,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import {
  makeTestThreads,
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testThread,
  testTicketRoute,
} from "../testing.ts";

const encodeItem = Schema.encodeSync(FleetMachinesItem);
const wireBytes = (item: FleetMachinesItem) =>
  new TextEncoder().encode(JSON.stringify(encodeItem(item))).length;

/** A browser's view of Fleet: every row by key, kept from the stream. */
const watchFleet = <E>(stream: Stream.Stream<FleetMachinesItem, E>) =>
  Effect.gen(function* () {
    const rows = new Map<string, FleetMachine>();
    const changed = yield* Queue.unbounded<void>();
    yield* Effect.forkScoped(
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item._tag === "snapshot") rows.clear();
            const upserts = item._tag === "snapshot" ? item.rows : item.upserts;
            for (const row of upserts) rows.set(fleetMachineKey(row), row);
            if (item._tag === "changes") for (const key of item.removals) rows.delete(key);
          }).pipe(Effect.andThen(Queue.offer(changed, undefined))),
        ),
      ),
    );
    /** Waits for the rows to satisfy `check`, as the stream delivers them. */
    const until = (check: (rows: ReadonlyMap<string, FleetMachine>) => boolean) =>
      Effect.gen(function* () {
        while (!check(rows)) yield* Queue.take(changed);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.die(new Error(`Fleet never got there: ${JSON.stringify([...rows.values()])}`)),
        }),
      );
    return { rows, until };
  });

describe("Fleet on the hub", () => {
  it.live("shows each machine live, offline when it stops, and back when it returns", () =>
    Effect.gen(function* () {
      const threads = yield* makeTestThreads;
      yield* threads.upsert(testThread("a", { session: "running" }));
      const startMachine = (scope: Scope.Scope) =>
        startTestServer({
          routes: testTicketRoute("machine-token"),
          ports: {
            threads: threads.ports,
            environment: Effect.succeed(
              testDescriptor({ environmentId: EnvironmentId.make("env-cpu-host-1") }),
            ),
          },
        }).pipe(Scope.provide(scope));

      const firstRun = yield* Scope.make();
      const machine = yield* startMachine(firstRun);
      const hub = yield* startTestServer({
        files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({ "cpu-host-1": machine.origin }) },
        ports: {
          getSecret: testHubSecrets({ "cpu-host-1": "machine-token" }),
          environment: Effect.succeed(
            testDescriptor({ environmentId: EnvironmentId.make("env-hub"), label: "hub" }),
          ),
        },
      });

      // Test it 1: every server shows, the hub's own row among them.
      const browser = yield* connect(hub.wsUrl("operator"));
      const fleet = yield* watchFleet(browser[MAGNESIUM_WS_METHODS.fleetMachines]({}));
      yield* fleet.until((rows) => rows.get("cpu-host-1")?.link === "connected");
      expect(fleet.rows.get("@self")).toMatchObject({
        kind: "hub",
        label: "hub",
        link: "connected",
      });
      expect(fleet.rows.get("cpu-host-1")).toMatchObject({
        kind: "machine",
        label: "cpu-host-1",
        serverVersion: "0.0.45",
        threads: { total: 1, running: 1, waiting: 0 },
      });

      // Test it 2: a thread that waits on you shows within two seconds.
      const asked = Date.now();
      yield* threads.upsert(testThread("b", { session: "running", approval: true }));
      yield* fleet.until((rows) => rows.get("cpu-host-1")?.threads?.waiting === 1);
      expect(Date.now() - asked).toBeLessThan(2_000);

      // Test it 3: the machine stops; it shows offline within ten seconds.
      const stopped = Date.now();
      yield* Scope.close(firstRun, Exit.void);
      yield* fleet.until((rows) => rows.get("cpu-host-1")?.link === "offline");
      expect(Date.now() - stopped).toBeLessThan(10_000);
      expect(fleet.rows.get("cpu-host-1")).toMatchObject({ threads: null });
      expect(fleet.rows.get("cpu-host-1")?.lastSeenAt).not.toBeNull();

      // Test it 5: a read-only session cannot call an operate RPC.
      const reader = yield* connect(hub.wsUrl("reader"));
      const refused = yield* reader[MAGNESIUM_WS_METHODS.fleetReconnect]({
        name: "cpu-host-1",
      }).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "EnvironmentAuthorizationError" });

      // It comes back (on a new port here); asking to reconnect skips the backoff.
      const secondRun = yield* Scope.make();
      const restarted = yield* startMachine(secondRun);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(hub.stateDir, HUB_MACHINES_CONFIG_FILE),
          testHubConfig({ "cpu-host-1": restarted.origin }),
        ),
      );
      yield* browser[MAGNESIUM_WS_METHODS.fleetReconnect]({ name: "cpu-host-1" });
      yield* fleet.until((rows) => rows.get("cpu-host-1")?.link === "connected");
      expect(fleet.rows.get("cpu-host-1")?.threads).toMatchObject({ total: 2, waiting: 1 });

      // The link's history, kept in the hub's database.
      const events = yield* browser[MAGNESIUM_WS_METHODS.fleetEvents]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      const first = events[0]!;
      expect(first._tag).toBe("snapshot");
      expect(first._tag === "snapshot" ? first.items.map((event) => event.link) : []).toEqual([
        "connected",
        "offline",
        "connected",
      ]);
      yield* Scope.close(secondRun, Exit.void);
    }),
  );
});

describe("Fleet's byte budget", () => {
  const row = (name: string): FleetMachine => ({
    name,
    label: name,
    kind: "machine",
    link: "connected",
    environmentId: EnvironmentId.make(
      `0e7c1f3a-58d2-4a7e-9c1b-${name.padEnd(12, "0").slice(0, 12)}`,
    ),
    serverVersion: "0.0.46-nightly.20261014.3132",
    release: "f0d9e1703a",
    deployment: null,
    node: null,
    startedAt: "2026-10-15T04:49:40.967Z",
    lastSeenAt: "2026-10-15T04:49:40.967Z",
    threads: { total: 140, running: 12, waiting: 3, approvals: 2, questions: 1 },
    detail: null,
  });

  it("opens Fleet for five servers in under 4 KiB, and sends each change in under 640 bytes", () => {
    const names = ["hub", "cpu-host-1", "cpu-host-2", "gpu-host-1", "gpu-host-2"];
    const snapshot: FleetMachinesItem = { _tag: "snapshot", sequence: 42, rows: names.map(row) };
    const change: FleetMachinesItem = {
      _tag: "changes",
      sequence: 43,
      upserts: [
        { ...row("gpu-host-2"), link: "offline", detail: "It stopped answering.", threads: null },
      ],
      removals: [],
    };
    expect(wireBytes(snapshot)).toBeLessThan(4 * 1024);
    expect(wireBytes(change)).toBeLessThan(640);
  });
});
