import {
  type FleetMachine,
  fleetMachineKey,
  type FooterItem,
  footerItemKey,
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
import * as LiveTable from "../stream/LiveTable.ts";
import { coreItems } from "./core.ts";

/**
 * The footer's items (goal 05), one live table keyed by item id. The core
 * items are derived from Fleet's rows; app items join them in goal 16.
 *
 * It follows Fleet only while someone watches the footer, as Fleet follows
 * this server's own status: a watched Fleet keeps that status subscription
 * open, and nothing else needs these labels yet. A new watcher waits for
 * Fleet's first rows, so it never gets labels left over from the last one.
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
  const table = yield* LiveTable.make<FooterItem>({ key: footerItemKey });

  const follow = yield* RcRef.make({
    acquire: Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const machines = new Map<string, FleetMachine>();
      yield* fleet.subscribeMachines({}).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            if (item._tag === "snapshot") machines.clear();
            for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
              machines.set(fleetMachineKey(row), row);
            }
            if (item._tag === "changes") for (const key of item.removals) machines.delete(key);
            for (const row of coreItems([...machines.values()])) yield* table.set(row);
            yield* Deferred.succeed(first, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
    }),
    idleTimeToLive: IDLE_TIME_TO_LIVE,
  });

  return Footer.of({
    subscribeItems: (input) =>
      Stream.unwrap(RcRef.get(follow).pipe(Effect.as(table.subscribe(input)))),
  });
});

export const layer = Layer.effect(Footer, make);
