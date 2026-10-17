import {
  type FleetEvent,
  type FleetMachine,
  fleetMachineKey,
  MAGNESIUM_WS_METHODS,
  type ThreadCounts,
} from "@magnesium/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { connectMagnesium, type MagnesiumRpcClient } from "./rpc.ts";
import {
  applyLiveLogItem,
  emptyLiveLog,
  type LiveLogState,
  mergeHistoryPage,
} from "./stream/liveLog.ts";
import {
  applyLiveTableItem,
  emptyLiveTable,
  type LiveTableState,
  resumeFrom,
} from "./stream/liveTable.ts";

/**
 * Fleet in the browser (goal 04): the hub's `magnesium.fleet.machines` and
 * `magnesium.fleet.events`, kept live over one socket that resumes from the
 * last sequence after a drop. The page renders `FleetView`; this module
 * holds no React.
 */

export interface FleetView {
  readonly machines: LiveTableState<FleetMachine>;
  readonly events: LiveLogState<FleetEvent>;
  /** `connecting` until the hub first answers; `reconnecting` after a drop. */
  readonly connection: "connecting" | "live" | "reconnecting";
}

export const initialFleetView: FleetView = {
  machines: emptyLiveTable(),
  events: emptyLiveLog(),
  connection: "connecting",
};

export interface FleetWatch {
  /** Ask the hub to retry a machine's link now. Needs the operate scope. */
  readonly reconnect: (name: string) => Promise<void>;
  readonly loadEarlierEvents: () => Promise<void>;
  readonly dispose: () => void;
}

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/** Follows the hub's Fleet over its route at `socketUrl` until disposed. */
export function watchFleet(socketUrl: string, onView: (view: FleetView) => void): FleetWatch {
  let view = initialFleetView;
  let client: MagnesiumRpcClient | null = null;
  const update = (next: FleetView) => {
    if (next === view) return;
    view = next;
    onView(view);
  };

  const session = Effect.gen(function* () {
    const connected = yield* connectMagnesium(socketUrl);
    client = connected;
    const machines = connected[MAGNESIUM_WS_METHODS.fleetMachines](resumeFrom(view.machines)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          const next = applyLiveTableItem(view.machines, item, fleetMachineKey);
          if (next !== view.machines || view.connection !== "live") {
            update({ ...view, machines: next, connection: "live" });
          }
        }),
      ),
    );
    const events = connected[MAGNESIUM_WS_METHODS.fleetEvents](resumeFrom(view.events)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          const next = applyLiveLogItem(view.events, item);
          if (next !== view.events) update({ ...view, events: next });
        }),
      ),
    );
    yield* Effect.all([machines, events], { concurrency: "unbounded", discard: true });
  }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => void (client = null))));

  const loop = Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const wasLive = view.connection === "live";
      yield* session.pipe(Effect.exit);
      // A session that got going starts the backoff over.
      attempt = view.connection === "live" && !wasLive ? 1 : attempt + 1;
      update({ ...view, connection: "reconnecting" });
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (attempt - 1));
      yield* Effect.sleep(Duration.millis(wait));
    }
  });

  const fiber = Effect.runFork(loop);

  const withClient = <A, E>(use: (client: MagnesiumRpcClient) => Effect.Effect<A, E>) =>
    client === null
      ? Promise.reject(new Error("Not connected to the hub."))
      : Effect.runPromise(use(client));

  return {
    reconnect: (name) =>
      withClient((connected) => connected[MAGNESIUM_WS_METHODS.fleetReconnect]({ name })),
    loadEarlierEvents: () => {
      const before = view.events.before;
      if (before === null) return Promise.resolve();
      return withClient((connected) =>
        connected[MAGNESIUM_WS_METHODS.fleetEventHistory]({ before }).pipe(
          Effect.map((page) => update({ ...view, events: mergeHistoryPage(view.events, page) })),
        ),
      );
    },
    dispose: () => void Effect.runFork(Fiber.interrupt(fiber)),
  };
}

/** Rows in display order: the serving server first, then machines by name. */
export const fleetRows = (state: LiveTableState<FleetMachine>): ReadonlyArray<FleetMachine> =>
  [...state.rows.values()].sort((left, right) =>
    left.name === null ? -1 : right.name === null ? 1 : left.name.localeCompare(right.name),
  );

/** The link's state in a few words; `formatTime` renders an ISO time for the reader. */
export const describeLink = (
  machine: FleetMachine,
  formatTime: (iso: string) => string,
): string => {
  switch (machine.link) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "offline":
      return machine.lastSeenAt === null
        ? "Offline"
        : `Offline, last seen ${formatTime(machine.lastSeenAt)}`;
    case "no-access":
      return "No access";
  }
};

const DEPLOYMENT_LABEL: Record<NonNullable<FleetMachine["deployment"]>, string> = {
  "bare-metal": "bare metal",
  vm: "VM",
  pod: "pod",
  attached: "attached",
};

/**
 * The version and the build, which tells a mixed deploy apart: the package
 * version stays the same across commits. `hubRelease` is the build of the
 * server serving the list.
 */
export const describeVersion = (machine: FleetMachine, hubRelease: string | null): string => {
  const parts = [machine.serverVersion ?? "Version unknown"];
  if (machine.release !== null) {
    const note = differsFromHub(machine, hubRelease) ? " (not the hub's build)" : "";
    parts.push(`${machine.release}${note}`);
  }
  return parts.join(" · ");
};

/**
 * Where and how a server runs, beside its name: a pod's name says nothing
 * about the machine it is on (goal 25). Null when it doesn't report it.
 */
export const describePlace = (machine: FleetMachine): string | null => {
  if (machine.deployment === null) return machine.node;
  // Attached to a workload's pod: the workload is what the owner knows it by.
  if (machine.deployment === "attached" && machine.workload !== null) {
    return machine.node === null
      ? `in ${machine.workload}`
      : `in ${machine.workload} on ${machine.node}`;
  }
  const how = DEPLOYMENT_LABEL[machine.deployment];
  return machine.node === null ? how : `${how} on ${machine.node}`;
};

/** What a row's badge means, for its tooltip. */
export const KIND_HINT: Record<FleetMachine["kind"], string> = {
  hub: "The server you reach Magnesium through; it carries the others.",
  machine: "A server that runs agents.",
  gateway:
    "The hub's door into a Kubernetes namespace, where it runs machines for the hub. It runs no agents.",
};

/** Whether a machine runs a different build than the hub. */
export function differsFromHub(machine: FleetMachine, hubRelease: string | null): boolean {
  return (
    machine.name !== null &&
    machine.release !== null &&
    hubRelease !== null &&
    machine.release !== hubRelease
  );
}

export const describeThreads = (threads: ThreadCounts | null): string =>
  threads === null ? "Unknown" : `${threads.running} running · ${threads.waiting} waiting on you`;

export const describeEvent = (event: FleetEvent): string => {
  switch (event.link) {
    case "connected":
      return `${event.machine} connected`;
    case "connecting":
      return `${event.machine} is connecting`;
    case "offline":
      return `${event.machine} went offline${event.detail ? `: ${event.detail}` : ""}`;
    case "no-access":
      return `The hub has no access to ${event.machine}${event.detail ? `: ${event.detail}` : ""}`;
  }
};
