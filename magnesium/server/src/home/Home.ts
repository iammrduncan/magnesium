import {
  type FleetMachine,
  fleetMachineKey,
  type HomeAnswerInput,
  HomeAnswerError,
  type HomeCounts,
  type HomeDetail,
  type HomeItem,
  homeItemKey,
  type HomePinInput,
  type HomeSummary,
  homeSummaryKey,
  type LiveTableItem,
  type LocalHomeItem,
  localHomeItemKey,
  type StreamSubscribeInput,
  toHomeKey,
} from "@magnesium/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { Fleet } from "../fleet/Fleet.ts";
import { ServerPorts } from "../ports.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import { LocalHome } from "./LocalHome.ts";
import { makePinStore } from "./pins.ts";
import { HomeRelay } from "./relay.ts";

/**
 * Home (goal 06) on the server the browser talks to: this server's own items
 * and every carried machine's, with the machine they came from and your pins,
 * as `magnesium.home.needs`, counted on `magnesium.home.summary` (which the
 * footer reads too). Answers go to the thread on its own machine. The browser
 * sorts with `compareHomeNeeds`; the hub only keeps the rows.
 */

/** Changes from the threads, the links and Fleet come in bursts; rebuild once per window. */
const REBUILD_COALESCE = Duration.millis(50);
const MAX_ITEMS = 2_000;

export interface HomeSource {
  readonly name: string | null;
  readonly label: string;
  readonly environmentId: EnvironmentId | null;
  readonly reachable: boolean;
  readonly items: Iterable<LocalHomeItem>;
}

const emptyCounts = (): { -readonly [K in keyof HomeCounts]: number } => ({
  approval: 0,
  question: 0,
  plan: 0,
  failure: 0,
  total: 0,
  running: 0,
});

/**
 * Home's rows and counts from every server's items. A machine the hub can't
 * reach keeps its needs on Home, marked unreachable and left out of the
 * counts, which name it instead; its "working" items are dropped, since
 * nothing says they still are.
 */
export const buildHome = (input: {
  readonly sources: ReadonlyArray<HomeSource>;
  readonly pins: ReadonlyMap<string, string>;
}): { readonly items: ReadonlyArray<HomeItem>; readonly summary: HomeSummary } => {
  const items: Array<HomeItem> = [];
  const counts = emptyCounts();
  const unseen: Array<string> = [];
  for (const source of input.sources) {
    if (!source.reachable) unseen.push(source.label);
    for (const item of source.items) {
      const running = item.body._tag === "running";
      if (running && !source.reachable) continue;
      const key = toHomeKey(source.name, localHomeItemKey(item));
      items.push({
        ...item,
        key,
        machine: { name: source.name, label: source.label, environmentId: source.environmentId },
        reachable: source.reachable,
        pinnedAt: input.pins.get(key) ?? null,
      });
      if (!source.reachable) continue;
      if (item.body._tag === "running") {
        counts.running += 1;
      } else {
        counts[item.body._tag] += 1;
        counts.total += 1;
      }
    }
  }
  return {
    items,
    summary: {
      key: "home",
      counts,
      unseen: unseen.toSorted((left, right) => left.localeCompare(right)),
    },
  };
};

export class Home extends Context.Service<
  Home,
  {
    readonly subscribeNeeds: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<HomeItem>>;
    readonly subscribeSummary: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<HomeSummary>>;
    readonly answer: (input: HomeAnswerInput) => Effect.Effect<void, HomeAnswerError>;
    readonly pin: (input: HomePinInput) => Effect.Effect<void>;
    readonly detail: (key: string) => Effect.Effect<HomeDetail, HomeAnswerError>;
  }
>()("@magnesium/server/home/Home") {}

const answerError = (detail: string) => new HomeAnswerError({ detail });

export const make = Effect.gen(function* () {
  const ports = yield* ServerPorts;
  const local = yield* LocalHome;
  const relay = yield* HomeRelay;
  const fleet = yield* Fleet;
  const pinStore = yield* makePinStore;
  const descriptor = yield* ports.environment;

  const itemsTable = yield* LiveTable.make<HomeItem>({ key: homeItemKey, maxRows: MAX_ITEMS });
  const summaryTable = yield* LiveTable.make<HomeSummary>({ key: homeSummaryKey });
  const selfItems = new Map<string, LocalHomeItem>();
  const fleetRows = new Map<string, FleetMachine>();
  const pins = new Map((yield* pinStore.load).map((pin) => [pin.key, pin.pinnedAt]));
  let shown = new Map<string, HomeItem>();
  const dirty = yield* Queue.sliding<void>(1);
  const poke = Queue.offer(dirty, undefined).pipe(Effect.asVoid);

  const sources = (): ReadonlyArray<HomeSource> => {
    const self = fleetRows.get("@self");
    const machines = relay.machines();
    return [
      {
        name: null,
        label: self?.label ?? descriptor.label,
        environmentId: descriptor.environmentId,
        reachable: true,
        items: selfItems.values(),
      },
      ...[...fleetRows.values()].flatMap((row) => {
        if (row.name === null) return [];
        const entry = machines.get(row.name);
        return [
          {
            name: row.name,
            label: row.label,
            environmentId: row.environmentId,
            reachable: entry?.reachable ?? false,
            items: entry?.items.values() ?? [],
          },
        ];
      }),
    ];
  };

  const rebuild = Effect.gen(function* () {
    const built = buildHome({ sources: sources(), pins });
    const next = new Map(built.items.map((item) => [item.key, item]));
    for (const [key, previous] of shown) {
      if (next.has(key)) continue;
      yield* itemsTable.remove(key);
      // An answered item never comes back; its pin goes with it. An offline
      // machine's items stay, so this never drops a pin for a blip.
      if (pins.has(key) && previous.reachable) {
        pins.delete(key);
        yield* pinStore.unpin(key);
      }
    }
    for (const item of built.items) yield* itemsTable.set(item);
    yield* summaryTable.set(built.summary);
    shown = next;
  });

  // Follow the sources for the life of the server: Home and its push (goal 07) need them always.
  yield* local.subscribe({}).pipe(
    Stream.runForEach((item) =>
      Effect.sync(() => {
        if (item._tag === "snapshot") selfItems.clear();
        for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
          selfItems.set(localHomeItemKey(row), row);
        }
        if (item._tag === "changes") for (const key of item.removals) selfItems.delete(key);
      }).pipe(Effect.andThen(poke)),
    ),
    Effect.forkScoped,
  );
  yield* fleet.subscribeMachines({}).pipe(
    Stream.runForEach((item) =>
      Effect.sync(() => {
        if (item._tag === "snapshot") fleetRows.clear();
        for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
          fleetRows.set(fleetMachineKey(row), row);
        }
        if (item._tag === "changes") for (const key of item.removals) fleetRows.delete(key);
      }).pipe(Effect.andThen(poke)),
    ),
    Effect.forkScoped,
  );
  yield* relay.changes.pipe(
    Stream.runForEach(() => poke),
    Effect.forkScoped,
  );
  yield* Queue.take(dirty).pipe(
    Effect.andThen(Effect.sleep(REBUILD_COALESCE)),
    Effect.andThen(Queue.clear(dirty)),
    Effect.andThen(rebuild),
    Effect.forever,
    Effect.forkScoped,
  );

  /** The machine to send an item's answer or detail request to, if it can take one. */
  const route = (key: string) =>
    Effect.gen(function* () {
      const item = Option.getOrUndefined(yield* itemsTable.get(key));
      if (item === undefined) {
        return yield* answerError("It was already answered, or the agent moved on.");
      }
      if (item.machine.name === null) return { item, calls: local } as const;
      const calls = relay.machines().get(item.machine.name)?.calls ?? null;
      if (!item.reachable || calls === null) {
        return yield* answerError(`${item.machine.label} is offline. Answer it when it's back.`);
      }
      return {
        item,
        calls: { answer: calls.answer, detail: calls.detail },
      } as const;
    });

  return Home.of({
    subscribeNeeds: itemsTable.subscribe,
    subscribeSummary: summaryTable.subscribe,
    answer: ({ key, answer }) =>
      route(key).pipe(
        Effect.flatMap(({ item, calls }) => calls.answer({ threadId: item.threadId, answer })),
      ),
    pin: ({ key, pinned }) =>
      Effect.gen(function* () {
        if (pinned) {
          const pinnedAt = DateTime.formatIso(yield* DateTime.now);
          pins.set(key, pinnedAt);
          yield* pinStore.pin(key, pinnedAt);
        } else {
          pins.delete(key);
          yield* pinStore.unpin(key);
        }
        yield* poke;
      }),
    detail: (key) =>
      route(key).pipe(Effect.flatMap(({ item, calls }) => calls.detail(item.threadId))),
  });
});

export const layer = Layer.effect(Home, make);
