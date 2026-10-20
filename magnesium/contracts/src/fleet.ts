import { EnvironmentId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HubMachineName } from "./hub.ts";
import { ServerDeployment, ThreadCounts } from "./status.ts";
import {
  BackupHealth,
  BackupName,
  UpkeepActivity,
  UpkeepLauncher,
  UpkeepResult,
} from "./upkeep.ts";

/**
 * Fleet: every server the hub reaches, live (goal 04). The hub keeps one link
 * to each machine's `magnesium.server.status` and gathers them here, with its
 * own status as one more row. Goal 10 adds metrics, GPUs and jobs.
 */

/**
 * - `connected`: the hub's link is up; the counts are live.
 * - `connecting`: the first try since the hub started.
 * - `offline`: the link is down; the hub retries with backoff.
 * - `no-access`: the hub holds no token the machine accepts.
 */
export const FleetLink = Schema.Literals(["connected", "connecting", "offline", "no-access"]);
export type FleetLink = typeof FleetLink.Type;

export const FleetMachine = Schema.Struct({
  /** The machine's name on the hub; null for the server serving the list. */
  name: Schema.NullOr(HubMachineName),
  label: Schema.String,
  /**
   * `hub` for a server that carries machines, `gateway` for a Kubernetes
   * namespace's gateway (goal 25), `machine` for the rest.
   */
  kind: Schema.Literals(["hub", "machine", "gateway"]),
  link: FleetLink,
  environmentId: Schema.NullOr(EnvironmentId),
  serverVersion: Schema.NullOr(Schema.String),
  /** The build it runs (`ServerStatus.release`); null when unknown. */
  release: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** How it is deployed (`ServerStatus.deployment`); null when unknown. */
  deployment: Schema.NullOr(ServerDeployment).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Where it runs (`ServerStatus.node`); null when unknown. */
  node: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The workload it is attached to (`ServerStatus.workload`); null for any other server. */
  workload: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  startedAt: Schema.NullOr(IsoDateTime),
  /** When the hub last heard from it; set when a link drops, kept across hub restarts. */
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** Null unless connected: counts the hub cannot see are not shown as zero. */
  threads: Schema.NullOr(ThreadCounts),
  /** Why it is offline or has no access, in a sentence. */
  detail: Schema.NullOr(Schema.String),
  // Its upkeep (goal 35), from its status, with what the hub itself is doing to it.
  /** The build a rollback goes back to; for a pod, the build the hub ran it on before. */
  previousRelease: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  platform: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  timeZone: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  launcher: Schema.NullOr(UpkeepLauncher).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  backups: Schema.NullOr(BackupHealth).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  activity: Schema.NullOr(UpkeepActivity).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastResult: Schema.NullOr(UpkeepResult).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type FleetMachine = typeof FleetMachine.Type;

/** A row's key in the Fleet table: the machine's name, or `@self` for the serving server. */
export const fleetMachineKey = (machine: Pick<FleetMachine, "name">) => machine.name ?? "@self";

/** One change in a link's state, kept in `magnesium.sqlite`. */
export const FleetEvent = Schema.Struct({
  sequence: NonNegativeInt,
  machine: HubMachineName,
  link: FleetLink,
  detail: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type FleetEvent = typeof FleetEvent.Type;

export const FleetReconnectInput = Schema.Struct({ name: HubMachineName });
export type FleetReconnectInput = typeof FleetReconnectInput.Type;

/** A server in Fleet: a machine's name on the hub, or null for the server answering. */
export const FleetServerInput = Schema.Struct({ machine: Schema.NullOr(HubMachineName) });
export type FleetServerInput = typeof FleetServerInput.Type;

export const FleetRestoreInput = Schema.Struct({
  machine: Schema.NullOr(HubMachineName),
  name: BackupName,
});
export type FleetRestoreInput = typeof FleetRestoreInput.Type;
