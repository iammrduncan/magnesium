import {
  type FleetMachine,
  fleetMachineKey,
  type FooterItem,
  footerItemKey,
  type HomeSummary,
  type LiveTableItem,
  type StreamSubscribeInput,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcRef from "effect/RcRef";
import * as Stream from "effect/Stream";

import { Fleet } from "../fleet/Fleet.ts";
import { Home } from "../home/Home.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import { coreItems } from "./core.ts";

/**
 * The footer's items (goal 05), one live table keyed by item id. Machines
 * comes from Fleet's rows and Needs you from Home's summary (goal 06); app
 * items join them in goal 16.
 *
 * It follows Fleet and Home only while someone watches the footer, as Fleet
 * follows this server's own status: a watched Fleet keeps that status
 * subscription open, and nothing else needs these labels yet. A new watcher
 * waits for both first rows, so it never gets labels left over from the last one.
 */

/** Keep following Fleet this long after the last watcher leaves, for quick reloads. */
export const IDLE_TIME_TO_LIVE = Duration.seconds(30);

export class Footer extends Context.Service<
  Footer,
  {
    readonly subscribeItems: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<FooterItem>>;
  }
>()("@magnesium/server/footer/Footer") {}

export const make = Effect.gen(function* () {
  const fleet = yield* Fleet;
  const home = yield* Home;
  const table = yield* LiveTable.make<FooterItem>({ key: footerItemKey });

  const follow = yield* RcRef.make({
    acquire: Effect.gen(function* () {
      const firstMachines = yield* Deferred.make<void>();
      const firstSummary = yield* Deferred.make<void>();
      const machines = new Map<string, FleetMachine>();
      let summary: HomeSummary | undefined;
      const publish = Effect.suspend(() =>
        summary === undefined
          ? Effect.void
          : Effect.forEach(coreItems([...machines.values()], summary), table.set, {
              discard: true,
            }),
      );
      yield* fleet.subscribeMachines({}).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            if (item._tag === "snapshot") machines.clear();
            for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
              machines.set(fleetMachineKey(row), row);
            }
            if (item._tag === "changes") for (const key of item.removals) machines.delete(key);
            yield* publish;
            yield* Deferred.succeed(firstMachines, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* home.subscribeSummary({}).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            const row = item._tag === "snapshot" ? item.rows[0] : item.upserts[0];
            if (row === undefined) return;
            summary = row;
            yield* publish;
            yield* Deferred.succeed(firstSummary, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstMachines);
      yield* Deferred.await(firstSummary);
    }),
    idleTimeToLive: IDLE_TIME_TO_LIVE,
  });

  return Footer.of({
    subscribeItems: (input) =>
      Stream.unwrap(RcRef.get(follow).pipe(Effect.as(table.subscribe(input)))),
  });
});

export const layer = Layer.effect(Footer, make);
