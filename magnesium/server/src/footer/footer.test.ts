// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - the test times what the browser sees and measures its bytes as JSON.
import {
  type FleetMachine,
  fleetMachineKey,
  type FooterItem,
  footerItemKey,
  FooterItemsItem,
  type HomeCounts,
  type HomeSummary,
  homeSummaryKey,
  type LiveTableItem,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { Fleet } from "../fleet/Fleet.ts";
import { Home } from "../home/Home.ts";
import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import {
  approvalActivity,
  makeTestThreads,
  questionActivity,
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testThread,
  testThreadDetail,
  testTicketRoute,
} from "../testing.ts";
import { coreItems, fleetItem, needsYouItem } from "./core.ts";
import * as Footer from "./Footer.ts";

const machine = (name: string | null, overrides: Partial<FleetMachine> = {}): FleetMachine => ({
  name,
  label: name ?? "hub",
  kind: name === null ? "hub" : "machine",
  link: "connected",
  environmentId: EnvironmentId.make(`env-${name ?? "hub"}`),
  serverVersion: "0.0.45",
  release: null,
  deployment: null,
  node: null,
  startedAt: "2026-10-15T04:00:00.000Z",
  lastSeenAt: null,
  threads: { total: 4, running: 1, waiting: 0, approvals: 0, questions: 0 },
  detail: null,
  ...overrides,
});

const waitingOn = (approvals: number, questions: number) => ({
  total: 6,
  running: 1,
  waiting: approvals + questions,
  approvals,
  questions,
});

const down = (name: string, link: "offline" | "no-access" | "connecting" = "offline") =>
  machine(name, { link, threads: null });

/** Home's summary with these needs; `total` is their sum. */
const summaryOf = (
  needs: Partial<Omit<HomeCounts, "total" | "running">> = {},
  unseen: ReadonlyArray<string> = [],
): HomeSummary => {
  const counts = { approval: 0, question: 0, plan: 0, failure: 0, running: 1, ...needs };
  return {
    key: "home",
    counts: {
      ...counts,
      total: counts.approval + counts.question + counts.plan + counts.failure,
    },
    unseen,
  };
};

describe("the core footer items", () => {
  it("count every server, the hub's own among them, and stay quiet while all are up", () => {
    const fleet = [machine(null), machine("cpu-host-1"), machine("gpu-host-1")];
    expect(fleetItem(fleet)).toMatchObject({
      id: "core:fleet",
      side: "left",
      label: "3 machines",
      detail: "All connected.",
      tone: "neutral",
    });
    expect(fleetItem([machine(null)]).label).toBe("1 machine");
  });

  it("count a server that is down or refuses the hub as offline, but not one still connecting", () => {
    const fleet = [
      machine(null),
      down("gpu-host-2"),
      down("cpu-host-2", "no-access"),
      down("cpu-host-1", "connecting"),
      machine("gpu-host-1"),
    ];
    expect(fleetItem(fleet)).toMatchObject({
      label: "5 machines · 2 offline",
      detail: "Offline: gpu-host-2. No access: cpu-host-2. Connecting: cpu-host-1.",
      tone: "warning",
    });
  });

  it("count what waits on you from Home's summary, and name the machines it can't see", () => {
    expect(needsYouItem(summaryOf({ approval: 3, question: 1 }, ["gpu-host-2"]))).toMatchObject({
      id: "core:needs-you",
      label: "Needs you 4",
      detail: "3 approvals and 1 question. Not counted, not connected: gpu-host-2.",
      tone: "warning",
    });
    expect(needsYouItem(summaryOf({ approval: 1, question: 1, plan: 1, failure: 2 })).detail).toBe(
      "1 approval, 1 question, 1 plan ready and 2 failures.",
    );

    // Unknown is never zero: the detail says what the hub can't see.
    expect(needsYouItem(summaryOf({}, ["gpu-host-2"]))).toMatchObject({
      label: "Needs you 0",
      detail:
        "Nothing waits on you on the machines the hub can see. Not counted, not connected: gpu-host-2.",
      tone: "neutral",
    });
    expect(needsYouItem(summaryOf()).detail).toBe("Nothing waits on you.");
    expect(needsYouItem(summaryOf({ question: 1 })).detail).toBe("1 question.");
  });
});

/** A stand-in for Fleet: a live table the test edits, which counts its watchers. */
const fakeFleet = Effect.gen(function* () {
  const table = yield* LiveTable.make<FleetMachine>({ key: fleetMachineKey });
  let watchers = 0;
  const service = Fleet.of({
    subscribeMachines: (input) =>
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => void (watchers += 1)),
          () => Effect.sync(() => void (watchers -= 1)),
        ).pipe(Effect.as(table.subscribe(input))),
      ),
    subscribeEvents: () => Stream.empty,
    eventHistory: () => Effect.die("unused"),
    reconnect: () => Effect.void,
  });
  return { table, service, watchers: () => watchers };
});

/** A stand-in for Home: its summary as a live table the test edits. */
const fakeHome = Effect.gen(function* () {
  const summary = yield* LiveTable.make<HomeSummary>({ key: homeSummaryKey });
  const service = Home.of({
    subscribeNeeds: () => Stream.empty,
    subscribeSummary: (input) => summary.subscribe(input),
    answer: () => Effect.die("unused"),
    pin: () => Effect.die("unused"),
    detail: () => Effect.die("unused"),
  });
  return { summary, service };
});

/** Runs a stream into a queue, in a fiber the test can stop. */
const collect = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<A>();
    const fiber = yield* Effect.forkScoped(
      stream.pipe(Stream.runForEach((item) => Queue.offer(items, item))),
    );
    return { items, fiber };
  });

const rowsOf = (item: LiveTableItem<FooterItem>) =>
  new Map((item._tag === "snapshot" ? item.rows : item.upserts).map((row) => [row.id, row]));

describe("Footer", () => {
  it.effect("opens with the core items, then sends one change when a machine goes down", () =>
    Effect.gen(function* () {
      const fleet = yield* fakeFleet;
      const home = yield* fakeHome;
      yield* fleet.table.set(machine(null));
      yield* fleet.table.set(machine("cpu-host-1", { threads: waitingOn(1, 0) }));
      yield* home.summary.set(summaryOf({ approval: 1 }));
      const footer = yield* Footer.make.pipe(
        Effect.provideService(Fleet, fleet.service),
        Effect.provideService(Home, home.service),
      );

      const { items } = yield* collect(footer.subscribeItems({}));
      const opened = yield* Queue.take(items);
      expect(opened._tag).toBe("snapshot");
      expect(rowsOf(opened).get("core:fleet")?.label).toBe("2 machines");
      expect(rowsOf(opened).get("core:needs-you")?.label).toBe("Needs you 1");

      yield* fleet.table.set(down("cpu-host-1"));
      yield* home.summary.set(summaryOf({}, ["cpu-host-1"]));
      // Fleet's and Home's coalescing windows, then the footer's.
      yield* TestClock.adjust("50 millis");
      yield* TestClock.adjust("50 millis");
      const changed = yield* Queue.take(items);
      expect(changed).toMatchObject({ _tag: "changes", removals: [] });
      expect(rowsOf(changed).get("core:fleet")).toMatchObject({
        label: "2 machines · 1 offline",
        tone: "warning",
      });
      expect(rowsOf(changed).get("core:needs-you")).toMatchObject({
        label: "Needs you 0",
        tone: "neutral",
      });
      expect(yield* Queue.size(items)).toBe(0);

      // A change Fleet sends that moves no label sends nothing.
      yield* fleet.table.set(down("cpu-host-1"));
      yield* fleet.table.set({ ...down("cpu-host-1"), lastSeenAt: "2026-10-15T05:00:00.000Z" });
      yield* TestClock.adjust("100 millis");
      expect(yield* Queue.size(items)).toBe(0);
    }),
  );

  it.effect("follows Fleet only while someone watches, and lets go once it has sat idle", () =>
    Effect.gen(function* () {
      const fleet = yield* fakeFleet;
      const home = yield* fakeHome;
      yield* fleet.table.set(machine(null));
      yield* home.summary.set(summaryOf());
      const footer = yield* Footer.make.pipe(
        Effect.provideService(Fleet, fleet.service),
        Effect.provideService(Home, home.service),
      );
      expect(fleet.watchers()).toBe(0);

      const first = yield* collect(footer.subscribeItems({}));
      const second = yield* collect(footer.subscribeItems({}));
      yield* Queue.take(first.items);
      yield* Queue.take(second.items);
      // Two browsers, one subscription to Fleet.
      expect(fleet.watchers()).toBe(1);

      yield* Fiber.interrupt(first.fiber);
      yield* Fiber.interrupt(second.fiber);
      yield* TestClock.adjust("10 seconds");
      expect(fleet.watchers()).toBe(1);
      yield* TestClock.adjust(Footer.IDLE_TIME_TO_LIVE);
      expect(fleet.watchers()).toBe(0);

      // Fleet changed while nobody watched; the next watcher gets the new labels, not old ones.
      yield* fleet.table.set(down("gpu-host-2"));
      const later = yield* collect(footer.subscribeItems({}));
      expect(rowsOf(yield* Queue.take(later.items)).get("core:fleet")?.label).toBe(
        "2 machines · 1 offline",
      );
    }),
  );
});

/** A browser's view of the footer: every item by id, kept from the stream. */
const watchFooter = <E>(stream: Stream.Stream<FooterItemsItem, E>) =>
  Effect.gen(function* () {
    const rows = new Map<string, FooterItem>();
    const changed = yield* Queue.unbounded<void>();
    yield* Effect.forkScoped(
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item._tag === "snapshot") rows.clear();
            for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
              rows.set(footerItemKey(row), row);
            }
            if (item._tag === "changes") for (const key of item.removals) rows.delete(key);
          }).pipe(Effect.andThen(Queue.offer(changed, undefined))),
        ),
      ),
    );
    const label = (id: string) => rows.get(id)?.label;
    /** Waits for the items to satisfy `check`, as the stream delivers them. */
    const until = (check: () => boolean) =>
      Effect.gen(function* () {
        while (!check()) yield* Queue.take(changed);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.die(
              new Error(`The footer never got there: ${JSON.stringify([...rows.values()])}`),
            ),
        }),
      );
    return { rows, label, until };
  });

describe("magnesium.footer.items on the hub", () => {
  it.live("counts the hub and its machines, what waits on you, and a machine that stops", () =>
    Effect.gen(function* () {
      const threads = yield* makeTestThreads;
      yield* threads.upsert(
        testThread("a", { session: "running", approval: true }),
        testThreadDetail("a", { activities: [approvalActivity("r1", "2026-10-16T01:00:00.000Z")] }),
      );
      const hubThreads = yield* makeTestThreads;
      yield* hubThreads.upsert(
        testThread("b", { question: true }),
        testThreadDetail("b", { activities: [questionActivity("r2", "2026-10-16T01:00:00.000Z")] }),
      );

      const machineRun = yield* Scope.make();
      const cpu = yield* startTestServer({
        routes: testTicketRoute("machine-token"),
        ports: {
          threads: threads.ports,
          environment: Effect.succeed(
            testDescriptor({ environmentId: EnvironmentId.make("env-cpu-host-1") }),
          ),
        },
      }).pipe(Scope.provide(machineRun));
      const hub = yield* startTestServer({
        files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({ "cpu-host-1": cpu.origin }) },
        ports: {
          threads: hubThreads.ports,
          getSecret: testHubSecrets({ "cpu-host-1": "machine-token" }),
          environment: Effect.succeed(
            testDescriptor({ environmentId: EnvironmentId.make("env-hub"), label: "hub" }),
          ),
        },
      });

      // A reader is enough: the footer is read scope, like Fleet.
      const browser = yield* connect(hub.wsUrl("reader"));
      const footer = yield* watchFooter(browser[MAGNESIUM_WS_METHODS.footerItems]({}));
      yield* footer.until(() => footer.label("core:needs-you") === "Needs you 2");
      expect(footer.label("core:fleet")).toBe("2 machines");
      expect(footer.rows.get("core:needs-you")?.detail).toBe("1 approval and 1 question.");

      // The machine stops: the footer says so within ten seconds, and stops counting it.
      const stopped = Date.now();
      yield* Scope.close(machineRun, Exit.void);
      yield* footer.until(() => footer.label("core:fleet") === "2 machines · 1 offline");
      expect(Date.now() - stopped).toBeLessThan(10_000);
      yield* footer.until(() => footer.label("core:needs-you") === "Needs you 1");
      expect(footer.rows.get("core:needs-you")?.detail).toBe(
        "1 question. Not counted, not connected: cpu-host-1.",
      );

      // A session with no scope gets nothing.
      const nobody = yield* connect(hub.wsUrl("nobody"));
      const refused = yield* nobody[MAGNESIUM_WS_METHODS.footerItems]({}).pipe(
        Stream.runCollect,
        Effect.flip,
      );
      expect(refused._tag).toBe("EnvironmentAuthorizationError");
    }),
  );
});

describe("the footer's byte budget", () => {
  const encode = Schema.encodeSync(FooterItemsItem);
  const wireBytes = (item: FooterItemsItem) =>
    new TextEncoder().encode(JSON.stringify(encode(item))).length;

  // The Footer board: the core items over five servers, and four app items.
  const fleet = [
    machine(null, { threads: waitingOn(2, 1) }),
    machine("cpu-host-1", { threads: waitingOn(1, 1) }),
    machine("cpu-host-2"),
    machine("gpu-host-1"),
    down("gpu-host-2"),
  ];
  const app = (id: string, label: string, detail: string, order: number): FooterItem => ({
    id,
    side: "right",
    order,
    label,
    detail,
    tone: "neutral",
    toggleLabel: label.split(" ")[0]!,
  });
  const summary = summaryOf({ approval: 3, question: 2 }, ["gpu-host-2"]);
  const rows = [
    ...coreItems(fleet, summary),
    app("gpu-board:load", "GPU 78%", "gpu-host-1 78%, gpu-host-2 idle.", 10),
    app("ingest-queue:pending", "Ingest 31/58", "31 of 58 pages ingested today.", 20),
    app("cost-and-usage:week", "Week 42%", "42% of this week's budget used.", 30),
    app("scheduler:failures", "Dream cycle failed", "Failed at 02:04 after 3 retries.", 40),
  ];

  it("opens the board's footer in under 1.5 KiB, and sends both core items' change in under 448 bytes", () => {
    // Sequences start at the server's clock, so they are thirteen digits on the wire.
    const snapshot: FooterItemsItem = { _tag: "snapshot", sequence: 1_760_503_780_967, rows };
    const change: FooterItemsItem = {
      _tag: "changes",
      sequence: 1_760_503_780_968,
      upserts: coreItems([...fleet.slice(0, 4), machine("gpu-host-2")], summaryOf({ approval: 3 })),
      removals: [],
    };
    // Measured: 1,031 and 357 bytes.
    expect(wireBytes(snapshot)).toBeLessThan(1536);
    expect(wireBytes(change)).toBeLessThan(448);
  });
});
