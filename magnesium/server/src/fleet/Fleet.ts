import {
  type FleetEvent,
  type FleetLink,
  type FleetMachine,
  fleetMachineKey,
  HomeAnswerError,
  type HistoryPage,
  type LiveLogItem,
  type LiveTableItem,
  MAGNESIUM_WS_METHODS,
  type ServerStatus as ServerStatusRow,
  type StreamHistoryInput,
  type StreamSubscribeInput,
  type UpkeepActivity,
  type UpkeepResult,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcRef from "effect/RcRef";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import { HomeRelay } from "../home/relay.ts";
import { HubMachines } from "../hub/HubMachines.ts";
import { connectMachine } from "../hub/machineRpc.ts";
import type { MagnesiumRpcClient } from "../rpc/client.ts";
import { ServerPorts } from "../ports.ts";
import { ServerStatus } from "../status/ServerStatus.ts";
import * as LiveLog from "../stream/LiveLog.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import { DEFAULT_LINK_TIMINGS, LinkDialError, type LinkTimings, runLink } from "./link.ts";
import { type FleetEventInput, makeFleetStore, type SeenMachine } from "./store.ts";

/**
 * Fleet (goal 04): every server this one reaches, live. On the hub, one link
 * per machine in `hub-machines.json` keeps its row current (`link.ts`); this
 * server's own status is one more row, read only while someone watches. Links
 * run for the life of the server, so later features (Home, push) can build on
 * them. A link's changes of state are kept as events in `magnesium.sqlite`,
 * with each machine's last-seen time, so a hub restart still knows when a
 * machine was last up.
 */

/** How often the hub rereads its machine list, which changes without a restart. */
const CONFIG_POLL = Duration.seconds(15);
const SELF_IDLE_TIME_TO_LIVE = Duration.seconds(30);

export class Fleet extends Context.Service<
  Fleet,
  {
    readonly subscribeMachines: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<FleetMachine>>;
    readonly subscribeEvents: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveLogItem<FleetEvent>>;
    readonly eventHistory: (input: StreamHistoryInput) => Effect.Effect<HistoryPage<FleetEvent>>;
    /** Retry a machine's link now instead of waiting out its backoff. */
    readonly reconnect: (name: string) => Effect.Effect<void>;
    /** Each machine's row as its link last saw it, read without asking any machine. */
    readonly machines: Effect.Effect<ReadonlyArray<FleetMachine>>;
    /** Every row, this server's own (`name: null`) included. */
    readonly rows: Effect.Effect<ReadonlyArray<FleetMachine>>;
    /** What the hub itself is doing to a server (goal 35), shown over what the server says. */
    readonly setUpkeep: (machine: string | null, overlay: UpkeepOverlay) => Effect.Effect<void>;
  }
>()("@magnesium/server/fleet/Fleet") {}

/**
 * The hub's own part in a server's upkeep: sending it a build, or changing a
 * pod's image. Its activity wins over the server's; the newer result wins.
 */
export interface UpkeepOverlay {
  readonly activity?: UpkeepActivity | null;
  readonly lastResult?: UpkeepResult;
  /** A pod's build before the hub changed it; its server can't know. */
  readonly previousRelease?: string | null;
}

/** A row's upkeep fields from a server's status; all unknown before it says. */
const upkeepOf = (status: ServerStatusRow | undefined) => ({
  previousRelease: status?.previousRelease ?? null,
  platform: status?.platform ?? null,
  timeZone: status?.timeZone ?? null,
  launcher: status?.launcher ?? null,
  backups: status?.backups ?? null,
  activity: status?.activity ?? null,
  lastResult: status?.lastResult ?? null,
});

const newer = (a: UpkeepResult | null, b: UpkeepResult | undefined) =>
  b === undefined || (a !== null && a.at >= b.at) ? a : b;

export const withOverlay = (row: FleetMachine, overlay: UpkeepOverlay | undefined): FleetMachine =>
  overlay === undefined
    ? row
    : {
        ...row,
        activity: overlay.activity ?? row.activity,
        lastResult: newer(row.lastResult, overlay.lastResult),
        previousRelease:
          overlay.previousRelease === undefined ? row.previousRelease : overlay.previousRelease,
      };

/** What the hub keeps of a machine's row across its own restarts. */
const seenOf = (name: string, row: FleetMachine): SeenMachine => ({
  name,
  label: row.label,
  environmentId: row.environmentId,
  serverVersion: row.serverVersion,
  lastSeenAt: row.lastSeenAt,
  kind: row.kind === "gateway" ? "gateway" : "machine",
  release: row.release,
  deployment: row.deployment,
  node: row.node,
  workload: row.workload,
});

const statusRowOf = (item: LiveTableItem<ServerStatusRow>) =>
  item._tag === "snapshot" ? item.rows[0] : item.upserts[0];

export const make = (
  options: { readonly timings?: LinkTimings; readonly configPoll?: Duration.Duration } = {},
) =>
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const machines = yield* HubMachines;
    const status = yield* ServerStatus;
    const httpClient = yield* HttpClient.HttpClient;
    // Home's items ride each link when Home is in the server (goal 06).
    const relay = Option.getOrUndefined(yield* Effect.serviceOption(HomeRelay));
    const store = yield* makeFleetStore;
    const descriptor = yield* ports.environment;
    const timings = options.timings ?? DEFAULT_LINK_TIMINGS;

    const table = yield* LiveTable.make<FleetMachine>({ key: fleetMachineKey });
    const log = yield* LiveLog.make<FleetEvent, FleetEventInput>({ store: store.events });
    const seen = new Map((yield* store.loadSeen).map((machine) => [machine.name, machine]));
    const links = yield* FiberMap.make<string>();
    const wakes = new Map<string, Queue.Queue<void>>();
    let carried: ReadonlyArray<string> = [];
    let selfStatus: ServerStatusRow | undefined;
    const overlays = new Map<string, UpkeepOverlay>();
    /** Each row as its server last said, before the hub's own upkeep work is laid over it. */
    const bases = new Map<string, FleetMachine>();
    const setRow = (row: FleetMachine) =>
      Effect.suspend(() => {
        const key = fleetMachineKey(row);
        bases.set(key, row);
        return table.set(withOverlay(row, overlays.get(key)));
      });

    const remember = (machine: SeenMachine) =>
      Effect.sync(() => seen.set(machine.name, machine)).pipe(
        Effect.andThen(store.saveSeen(machine)),
      );

    const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

    const selfRow = (): FleetMachine => ({
      name: null,
      label: descriptor.label,
      kind: carried.length > 0 ? "hub" : "machine",
      link: "connected",
      environmentId: descriptor.environmentId,
      serverVersion: descriptor.serverVersion,
      release: status.release,
      deployment: status.deployment,
      node: status.node,
      workload: status.workload,
      startedAt: status.startedAt,
      lastSeenAt: null,
      threads: selfStatus?.threads ?? null,
      detail: null,
      ...upkeepOf(selfStatus),
    });

    // This server's own counts are followed only while someone watches Fleet.
    const watchSelf = yield* RcRef.make({
      acquire: Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        yield* status.subscribe({}).pipe(
          Stream.runForEach((item) => {
            const row = statusRowOf(item);
            if (row !== undefined) selfStatus = row;
            return setRow(selfRow()).pipe(Effect.andThen(Deferred.succeed(first, undefined)));
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(first);
      }),
      idleTimeToLive: SELF_IDLE_TIME_TO_LIVE,
    });

    const appendEvent = (machine: string, link: FleetLink, detail: string | null) =>
      DateTime.now.pipe(
        Effect.flatMap((now) => log.append({ machine, link, detail, at: DateTime.formatIso(now) })),
      );

    const handlersFor = (name: string) => ({
      onStatus: (machine: ServerStatusRow) =>
        Effect.gen(function* () {
          const previous = bases.get(name);
          if (previous === undefined) return;
          const next: FleetMachine = {
            name,
            label: machine.label,
            kind: machine.role === "gateway" ? "gateway" : "machine",
            link: "connected",
            environmentId: machine.environmentId,
            serverVersion: machine.serverVersion,
            release: machine.release,
            deployment: machine.deployment,
            node: machine.node,
            workload: machine.workload,
            startedAt: machine.startedAt,
            lastSeenAt: previous.lastSeenAt,
            threads: machine.threads,
            detail: null,
            ...upkeepOf(machine),
          };
          yield* setRow(next);
          if (previous.link === "connected") return;
          yield* appendEvent(name, "connected", null);
          yield* remember(seenOf(name, next));
        }),
      onDown: (down: {
        readonly link: "offline" | "no-access";
        readonly detail: string;
        readonly lastSeenAt: number | null;
      }) =>
        Effect.gen(function* () {
          const previous = bases.get(name);
          if (previous === undefined) return;
          if (relay !== undefined) yield* relay.down(name);
          const lastSeenAt =
            down.lastSeenAt === null ? previous.lastSeenAt : isoAt(down.lastSeenAt);
          yield* setRow({
            ...previous,
            link: down.link,
            detail: down.detail,
            threads: null,
            lastSeenAt,
          });
          if (previous.link !== down.link) yield* appendEvent(name, down.link, down.detail);
          if (lastSeenAt !== previous.lastSeenAt) {
            yield* remember(seenOf(name, { ...previous, lastSeenAt }));
          }
        }),
    });

    /**
     * The machine's Home items, kept in the relay for the life of the link. A
     * machine whose build has no Home keeps its link; its items just aren't seen.
     */
    const followHome = (name: string, client: MagnesiumRpcClient): Effect.Effect<never> => {
      if (relay === undefined) return Effect.never;
      const toAnswerError = (error: { readonly _tag: string }) =>
        error._tag === "HomeAnswerError"
          ? (error as HomeAnswerError)
          : new HomeAnswerError({ detail: `${name} did not answer.` });
      return relay
        .connected(name, {
          answer: (input) =>
            client[MAGNESIUM_WS_METHODS.needsAnswer](input).pipe(Effect.mapError(toAnswerError)),
          detail: (threadId) =>
            client[MAGNESIUM_WS_METHODS.needsDetail]({ threadId }).pipe(
              Effect.mapError(toAnswerError),
            ),
          profileRequest: (id) =>
            client[MAGNESIUM_WS_METHODS.profileRequestGet]({ id }).pipe(
              Effect.mapError((error) =>
                error._tag === "ProfileError"
                  ? new HomeAnswerError({ detail: error.detail })
                  : new HomeAnswerError({ detail: `${name} did not answer.` }),
              ),
            ),
        })
        .pipe(
          Effect.andThen(
            client[MAGNESIUM_WS_METHODS.needsLocal]({}).pipe(
              Stream.runForEach((item) => relay.apply(name, item)),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Stopped following a machine's Home items.", {
              machine: name,
              cause,
            }),
          ),
          Effect.andThen(relay.down(name)),
          Effect.andThen(Effect.never),
        );
    };

    /** Dial a machine's `MagnesiumRpcGroup`, as the hub, and keep its status and ping. */
    const dial = (name: string) =>
      connectMachine(name).pipe(
        Effect.map((client) => ({
          status: client[MAGNESIUM_WS_METHODS.serverStatus]({}),
          ping: client[MAGNESIUM_WS_METHODS.ping]({}),
          alongside: followHome(name, client),
        })),
        Effect.catchTags({
          HubMachineNotFoundError: () =>
            Effect.fail(
              new LinkDialError({
                link: "offline",
                detail: "It is not in the hub's machine list.",
              }),
            ),
          HubMachineAccessError: (error) =>
            Effect.fail(new LinkDialError({ link: "no-access", detail: error.detail })),
          MachineRequestError: (error) =>
            Effect.fail(
              error.rejected
                ? new LinkDialError({
                    link: "no-access",
                    detail: "It refused the hub's token. Give the hub access again.",
                  })
                : new LinkDialError({ link: "offline", detail: "It did not answer." }),
            ),
          ServerPortError: (error) =>
            Effect.fail(new LinkDialError({ link: "offline", detail: error.detail })),
        }),
        Effect.provideService(HubMachines, machines),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

    const startLink = (name: string) =>
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1);
        wakes.set(name, wake);
        const known = seen.get(name);
        yield* setRow({
          name,
          label: known?.label ?? name,
          // As it last said, until it says again.
          kind: known?.kind ?? "machine",
          link: "connecting",
          environmentId: known?.environmentId ?? null,
          serverVersion: known?.serverVersion ?? null,
          release: known?.release ?? null,
          deployment: known?.deployment ?? null,
          node: known?.node ?? null,
          workload: known?.workload ?? null,
          startedAt: null,
          lastSeenAt: known?.lastSeenAt ?? null,
          threads: null,
          detail: null,
          ...upkeepOf(undefined),
        });
        yield* FiberMap.run(
          links,
          name,
          runLink({ dial: dial(name), handlers: handlersFor(name), wake, timings }),
        );
      });

    const stopLink = (name: string) =>
      Effect.gen(function* () {
        wakes.delete(name);
        yield* FiberMap.remove(links, name);
        bases.delete(name);
        overlays.delete(name);
        yield* table.remove(name);
        if (relay !== undefined) yield* relay.forget(name);
      });

    /** Follow the hub's machine list: start new links, stop removed ones. */
    const syncLinks = Effect.gen(function* () {
      const names = yield* machines.names;
      const previous = carried;
      carried = names;
      for (const name of names) if (!wakes.has(name)) yield* startLink(name);
      for (const name of previous) if (!names.includes(name)) yield* stopLink(name);
      if (previous.length > 0 !== names.length > 0) yield* setRow(selfRow());
    });

    const reconnect = (name: string) =>
      Effect.sync(() => {
        const wake = wakes.get(name);
        if (wake !== undefined) Queue.offerUnsafe(wake, undefined);
      });

    yield* syncLinks;
    yield* setRow(selfRow());
    yield* syncLinks.pipe(
      Effect.repeat(Schedule.spaced(options.configPoll ?? CONFIG_POLL)),
      Effect.forkScoped,
    );
    // Access given or taken away: try that machine now.
    yield* machines.accessChanged.pipe(Stream.runForEach(reconnect), Effect.forkScoped);
    // A machine added or forgotten in the app: follow the list now, not at the next poll.
    yield* machines.listChanged.pipe(
      Stream.runForEach(() => syncLinks),
      Effect.forkScoped,
    );

    return Fleet.of({
      subscribeMachines: (input) =>
        Stream.unwrap(RcRef.get(watchSelf).pipe(Effect.as(table.subscribe(input)))),
      subscribeEvents: log.subscribe,
      eventHistory: log.history,
      reconnect,
      machines: table.snapshot.pipe(
        Effect.map(({ rows }) => rows.filter((row) => row.name !== null)),
      ),
      rows: table.snapshot.pipe(Effect.map(({ rows }) => rows)),
      setUpkeep: (machine, overlay) =>
        Effect.gen(function* () {
          const key = machine ?? "@self";
          overlays.set(key, { ...overlays.get(key), ...overlay });
          const row = bases.get(key);
          if (row !== undefined) yield* table.set(withOverlay(row, overlays.get(key)));
        }),
    });
  });

export const layer = Layer.effect(Fleet, make());
