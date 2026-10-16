import {
  type HomeAnswerError,
  type HomeDetail,
  type LiveTableItem,
  type LocalAnswerInput,
  type LocalHomeItem,
  localHomeItemKey,
} from "@magnesium/contracts";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

/**
 * The hub's copy of each machine's Home items (goal 06), fed by Fleet's link
 * to that machine over the same socket as its status, and how to reach the
 * machine to answer one. A machine whose link drops keeps its items, marked
 * unreachable, so its cards stay on Home until it comes back.
 */

export interface MachineCalls {
  readonly answer: (input: LocalAnswerInput) => Effect.Effect<void, HomeAnswerError>;
  readonly detail: (threadId: ThreadId) => Effect.Effect<HomeDetail, HomeAnswerError>;
}

export interface MachineHome {
  readonly items: ReadonlyMap<string, LocalHomeItem>;
  /** The link is up and the machine has sent its items. */
  readonly reachable: boolean;
  /** Set while reachable. */
  readonly calls: MachineCalls | null;
}

export class HomeRelay extends Context.Service<
  HomeRelay,
  {
    /** The link is up; its items follow through `apply`. */
    readonly connected: (machine: string, calls: MachineCalls) => Effect.Effect<void>;
    readonly apply: (machine: string, item: LiveTableItem<LocalHomeItem>) => Effect.Effect<void>;
    /** The link dropped: keep the items, unreachable. */
    readonly down: (machine: string) => Effect.Effect<void>;
    /** The machine left the hub's list. */
    readonly forget: (machine: string) => Effect.Effect<void>;
    readonly machines: () => ReadonlyMap<string, MachineHome>;
    /** Fires after any change, for Home to rebuild. */
    readonly changes: Stream.Stream<void>;
  }
>()("@magnesium/server/home/relay/HomeRelay") {}

interface Entry {
  items: Map<string, LocalHomeItem>;
  reachable: boolean;
  calls: MachineCalls | null;
  /** Calls given on connect, used once the first snapshot makes it reachable. */
  pending: MachineCalls | null;
}

export const make = Effect.gen(function* () {
  const entries = new Map<string, Entry>();
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const entryOf = (machine: string) => {
    let entry = entries.get(machine);
    if (entry === undefined) {
      entry = { items: new Map(), reachable: false, calls: null, pending: null };
      entries.set(machine, entry);
    }
    return entry;
  };

  return HomeRelay.of({
    connected: (machine, calls) =>
      Effect.sync(() => {
        entryOf(machine).pending = calls;
      }),
    apply: (machine, item) =>
      Effect.suspend(() => {
        const entry = entryOf(machine);
        if (item._tag === "snapshot") {
          entry.items = new Map(item.rows.map((row) => [localHomeItemKey(row), row]));
        } else {
          for (const row of item.upserts) entry.items.set(localHomeItemKey(row), row);
          for (const key of item.removals) entry.items.delete(key);
        }
        if (entry.pending !== null) {
          entry.calls = entry.pending;
          entry.pending = null;
        }
        entry.reachable = entry.calls !== null;
        return notify;
      }),
    down: (machine) =>
      Effect.suspend(() => {
        const entry = entries.get(machine);
        if (entry === undefined) return Effect.void;
        entry.reachable = false;
        entry.calls = null;
        entry.pending = null;
        return notify;
      }),
    forget: (machine) => Effect.suspend(() => (entries.delete(machine) ? notify : Effect.void)),
    machines: () => entries,
    changes: Stream.fromPubSub(changed),
  });
});

export const layer = Layer.effect(HomeRelay, make);
