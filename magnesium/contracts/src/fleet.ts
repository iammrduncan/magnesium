import { EnvironmentId, IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { HubMachineName } from "./hub.ts";
import { ThreadCounts } from "./status.ts";

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
  /** `hub` for a server that carries machines, `machine` for the rest. */
  kind: Schema.Literals(["hub", "machine"]),
  link: FleetLink,
  environmentId: Schema.NullOr(EnvironmentId),
  serverVersion: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  /** When the hub last heard from it; set when a link drops, kept across hub restarts. */
  lastSeenAt: Schema.NullOr(IsoDateTime),
  /** Null unless connected: counts the hub cannot see are not shown as zero. */
  threads: Schema.NullOr(ThreadCounts),
  /** Why it is offline or has no access, in a sentence. */
  detail: Schema.NullOr(Schema.String),
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
