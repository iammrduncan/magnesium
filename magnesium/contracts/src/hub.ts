import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The hub carries every machine server under its own origin, so a device that
 * pairs with the hub sees every environment (doc 11, "The front door"). The
 * machines' tokens stay on the hub; the browser only ever holds its hub session.
 */

/** Every machine is served at `<hub origin>/api/magnesium/env/<name>/…`. */
export const HUB_ENVIRONMENT_ROUTE_PREFIX = "/api/magnesium/env";
export const HUB_MACHINES_PATH = "/api/magnesium/hub/machines";
/** Any server: swap the caller's bearer session for a fresh one before it expires. */
export const SESSION_RENEW_PATH = "/api/magnesium/session/renew";

export const HubMachineName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
export type HubMachineName = typeof HubMachineName.Type;

export const hubEnvironmentBasePath = (name: string): string =>
  `${HUB_ENVIRONMENT_ROUTE_PREFIX}/${encodeURIComponent(name)}/`;

export const hubMachineAccessPath = (name: string): string =>
  `${HUB_MACHINES_PATH}/${encodeURIComponent(name)}/access`;

/**
 * - `ready`: the hub holds a live token, so clients can reach the machine.
 * - `missing`: nobody has given the hub access yet.
 * - `expired`: the hub's token lapsed or was revoked; give it access again.
 */
export const HubMachineAccess = Schema.Literals(["ready", "missing", "expired"]);
export type HubMachineAccess = typeof HubMachineAccess.Type;

export const HubMachine = Schema.Struct({
  name: HubMachineName,
  /** The machine's own label, from its descriptor; the name until it has been reached once. */
  label: Schema.String,
  /** Null until the hub has reached the machine once. */
  environmentId: Schema.NullOr(EnvironmentId),
  access: HubMachineAccess,
  /** When the hub's token runs out. The hub renews it a week before. */
  accessExpiresAt: Schema.NullOr(Schema.String),
  /** Whether the hub reached the machine the last time it looked. */
  online: Schema.Boolean,
});
export type HubMachine = typeof HubMachine.Type;

export const HubMachineList = Schema.Struct({
  machines: Schema.Array(HubMachine),
});
export type HubMachineList = typeof HubMachineList.Type;

/**
 * Give the hub access to a machine: a bearer token a browser already holds for
 * it (moving it off the browser), or a pairing code minted on the machine.
 */
export const HubMachineAccessInput = Schema.Union([
  Schema.Struct({ bearerToken: Schema.NonEmptyString }),
  Schema.Struct({ pairingCode: Schema.NonEmptyString }),
]);
export type HubMachineAccessInput = typeof HubMachineAccessInput.Type;

export const SessionRenewResult = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Schema.String,
});
export type SessionRenewResult = typeof SessionRenewResult.Type;
