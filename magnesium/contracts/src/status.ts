import { EnvironmentId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BackupHealth, UpkeepActivity, UpkeepLauncher, UpkeepResult } from "./upkeep.ts";

/**
 * What every Magnesium server says about itself. The hub keeps one live
 * subscription to each machine's status and gathers them into Fleet (goal 04).
 */

/** Active (not archived) threads. `running` and `waiting` never overlap. */
export const ThreadCounts = Schema.Struct({
  total: NonNegativeInt,
  /** Working on a turn, or on background work, and not waiting on you. */
  running: NonNegativeInt,
  /** Waiting on you: a pending approval or a question. */
  waiting: NonNegativeInt,
  approvals: NonNegativeInt,
  questions: NonNegativeInt,
});
export type ThreadCounts = typeof ThreadCounts.Type;

/**
 * How a server is deployed (goal 25, D52, D59): on a host, in a VM, as its own
 * pod, or attached inside a workload's pod.
 */
export const ServerDeployment = Schema.Literals(["bare-metal", "vm", "pod", "attached"]);
export type ServerDeployment = typeof ServerDeployment.Type;

export const ServerStatus = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  serverVersion: Schema.String,
  /**
   * The build it runs, `magnesium-release`'s name for it (a commit); null in
   * development. The version alone hides a mixed deploy. A server that predates
   * it sends none.
   */
  release: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** How it is deployed (`MAGNESIUM_DEPLOY`); null when unset, as in development. */
  deployment: Schema.NullOr(ServerDeployment).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Where it runs, for a pod its node (`MAGNESIUM_NODE`); null when it doesn't say. */
  node: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The workload it is attached to (`MAGNESIUM_WORKLOAD`); null for any other server. */
  workload: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** `gateway` for a namespace's gateway (goal 25); null for a server that runs agents. */
  role: Schema.NullOr(Schema.Literals(["gateway"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  startedAt: IsoDateTime,
  threads: ThreadCounts,
  // Goal 35: what Fleet shows about a server's upkeep, and what it can do there.
  /** The build `magnesium-release rollback` goes back to; null when there is none. */
  previousRelease: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** `<os>-<cpu>`, such as `linux-x64`: whether it can run another server's build as it is. */
  platform: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The IANA time zone its clock and scheduled tasks keep (D64). */
  timeZone: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** What restarts it and runs its pending work; null when nothing does. */
  launcher: Schema.NullOr(UpkeepLauncher).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Null from a server that predates its own backups. */
  backups: Schema.NullOr(BackupHealth).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  activity: Schema.NullOr(UpkeepActivity).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastResult: Schema.NullOr(UpkeepResult).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type ServerStatus = typeof ServerStatus.Type;

export const PingResult = Schema.Struct({
  serverVersion: Schema.String,
  startedAt: IsoDateTime,
  now: IsoDateTime,
});
export type PingResult = typeof PingResult.Type;
