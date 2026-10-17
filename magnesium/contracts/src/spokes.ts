import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HubMachineName } from "./hub.ts";

/**
 * Spokes in Kubernetes (goal 25, D57): the hub asks a namespace's gateway to
 * run, change or remove its spokes. Everything here is what Magnesium decides;
 * the cluster operator's envelope (nodes, quota, security level, network) is checked by the
 * cluster and can only refuse.
 */

/** A DNS label: a pod's host name and the parts of object names. */
const DnsLabel = Schema.String.check(Schema.isPattern(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/));

export const SpokeSpec = Schema.Struct({
  /** The spoke's name on the hub, its `MAGNESIUM_MACHINE`; its objects are `magnesium-<name>`. */
  name: HubMachineName,
  /** The node it runs on, from the namespace's allowed list. */
  node: Schema.String.check(Schema.isMinLength(1)),
  /** `HOME`: where its volume is mounted. A moved machine keeps its user's home path. */
  home: Schema.String.check(Schema.isPattern(/^\/[^\0]*$/)),
  /** The pod's host name, which Fleet and Home show as its label. */
  hostname: DnsLabel,
  /** The build it runs (a commit); null runs the gateway's own. */
  build: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/))),
  /** Its volume's size, such as `100Gi`. Growing it later needs a storage class that allows it. */
  volumeSize: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*(Mi|Gi|Ti)$/)),
  /** OpenCode's gateway and models; null leaves OpenCode unconfigured. */
  opencode: Schema.NullOr(
    Schema.Struct({
      baseUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
      models: Schema.NonEmptyArray(Schema.String.check(Schema.isMinLength(1))),
    }),
  ),
  /** 1 runs it, 0 stops it and keeps its volume. */
  replicas: Schema.Literals([0, 1]),
});
export type SpokeSpec = typeof SpokeSpec.Type;

/**
 * Values a spoke reads from its Secret, by name only. Sent with a spec and
 * written straight to the Secret; never stored on the gateway or sent back.
 */
export const SpokeSecrets = Schema.Struct({
  /** A one-time code the hub pairs with (`MAGNESIUM_HUB_PAIRING_CODE`); null once paired. */
  pairingCode: Schema.NullOr(Schema.String.check(Schema.isMinLength(16))),
  /** Keys agents use, by environment name, such as `LITELLM_API_KEY`. */
  keys: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)),
    Schema.String.check(Schema.isMinLength(1)),
  ),
});
export type SpokeSecrets = typeof SpokeSecrets.Type;

export const SpokeApplyInput = Schema.Struct({
  spec: SpokeSpec,
  /** Null keeps the Secret as it is. */
  secrets: Schema.NullOr(SpokeSecrets),
});
export type SpokeApplyInput = typeof SpokeApplyInput.Type;

export const SpokeRemoveInput = Schema.Struct({
  name: HubMachineName,
  /** Keep the spoke's volume (its home), so it can come back. */
  keepVolume: Schema.Boolean,
});
export type SpokeRemoveInput = typeof SpokeRemoveInput.Type;

/** A spoke as the cluster sees it. */
export const SpokeStatus = Schema.Struct({
  name: HubMachineName,
  node: Schema.NullOr(Schema.String),
  /** The build its pod runs; null when its image doesn't say. */
  build: Schema.NullOr(Schema.String),
  replicas: Schema.Number,
  ready: Schema.Boolean,
  /** Why it isn't ready, in a sentence, such as the cluster's refusal. */
  detail: Schema.NullOr(Schema.String),
});
export type SpokeStatus = typeof SpokeStatus.Type;

export class SpokeError extends Schema.TaggedError<SpokeError>()("SpokeError", {
  /** What went wrong, in a sentence for Fleet, such as the cluster refusing a node. */
  detail: Schema.String,
}) {}

/** A spoke the hub runs through a gateway, as the hub keeps it. */
export const HubSpoke = Schema.Struct({
  name: HubMachineName,
  /** The hub machine that is its namespace's gateway. */
  gateway: HubMachineName,
  spec: SpokeSpec,
  /** Model keys it gets from the hub, by environment name. */
  keys: Schema.Array(Schema.String),
  /** As its gateway sees it; null when the gateway can't be asked. */
  status: Schema.NullOr(SpokeStatus),
  /** Whether the hub has access to it yet; a new spoke pairs once it is up. */
  paired: Schema.Boolean,
  /** What's in the way, in a sentence, such as an unreachable gateway. */
  detail: Schema.NullOr(Schema.String),
});
export type HubSpoke = typeof HubSpoke.Type;

export const HubSpokeApplyInput = Schema.Struct({
  gateway: HubMachineName,
  spec: SpokeSpec,
  keys: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/))),
});
export type HubSpokeApplyInput = typeof HubSpokeApplyInput.Type;

/**
 * A machine attached inside a workload's pod (D59). The hub reaches it through
 * a gateway, as a spoke, but the workload's own deploy starts, stops and
 * removes it.
 */
export const HubAttached = Schema.Struct({
  name: HubMachineName,
  /** The hub machine that is its namespace's gateway. */
  gateway: HubMachineName,
  /** The workload it runs in, when its gateway says. */
  workload: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Whether the hub has access to it; a new one pairs with its code once it answers. */
  paired: Schema.Boolean,
  /** What's in the way, in a sentence. */
  detail: Schema.NullOr(Schema.String),
});
export type HubAttached = typeof HubAttached.Type;

/**
 * A machine a gateway routes to inside a workload's pod (D59), as the
 * operator's deploy labelled the route. A new one comes with a one-time
 * pairing code until the hub has paired, so it joins with no one typing it.
 */
export const GatewayAttached = Schema.Struct({
  name: HubMachineName,
  workload: Schema.NullOr(Schema.String),
  /** The hub paired with it already: its route is marked, and its code is spent. */
  paired: Schema.Boolean,
  pairingCode: Schema.NullOr(Schema.String),
});
export type GatewayAttached = typeof GatewayAttached.Type;

export const GatewayAttachedPairedInput = Schema.Struct({ name: HubMachineName });
export type GatewayAttachedPairedInput = typeof GatewayAttachedPairedInput.Type;

export const HubAttachInput = Schema.Struct({
  name: HubMachineName,
  gateway: HubMachineName,
  /** The one-time code in its pairing Secret; null for a moved machine the hub already has. */
  pairingCode: Schema.NullOr(Schema.String.check(Schema.isMinLength(16))),
});
export type HubAttachInput = typeof HubAttachInput.Type;

export const HubDetachInput = Schema.Struct({
  name: HubMachineName,
  /**
   * Keep the hub's access, for a machine going back to where it ran before (its
   * bare metal, say), whose state accepts the same token.
   */
  keepAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type HubDetachInput = typeof HubDetachInput.Type;

/** A model key's environment name, such as `LITELLM_API_KEY`. Its value is never sent back. */
export const ModelKeyName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/));

export const ModelKeySetInput = Schema.Struct({
  name: ModelKeyName,
  value: Schema.String.check(Schema.isMinLength(1)),
});
export type ModelKeySetInput = typeof ModelKeySetInput.Type;

export const ModelKeyRemoveInput = Schema.Struct({ name: ModelKeyName });
export type ModelKeyRemoveInput = typeof ModelKeyRemoveInput.Type;
