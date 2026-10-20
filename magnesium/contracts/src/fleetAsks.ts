import * as Schema from "effect/Schema";

import { FleetMachine } from "./fleet.ts";
import { HubMachineName } from "./hub.ts";
import { BackupName } from "./upkeep.ts";

/**
 * What agents may do to the fleet (goal 35, D66): read it freely, and ask for
 * every change, which waits on Home until the owner approves it. A request is
 * kept and carried out on the server the agent asked, through that server's
 * Fleet: on the hub, every machine; elsewhere, that server itself.
 */

/** A server in Fleet, by its name on the hub; left out, the server the agent asks. */
const Server = Schema.optionalKey(HubMachineName);
const Summary = Schema.String;

export const FleetServerAsk = Schema.Struct({ server: Server, summary: Summary });
export type FleetServerAsk = typeof FleetServerAsk.Type;

export const RestoreBackupAsk = Schema.Struct({
  server: Server,
  backup: BackupName,
  summary: Summary,
});
export type RestoreBackupAsk = typeof RestoreBackupAsk.Type;

export const AddMachineAsk = Schema.Struct({
  name: HubMachineName,
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/)),
  pairingCode: Schema.NonEmptyString,
  summary: Summary,
});
export type AddMachineAsk = typeof AddMachineAsk.Type;

export const ForgetMachineAsk = Schema.Struct({ server: HubMachineName, summary: Summary });
export type ForgetMachineAsk = typeof ForgetMachineAsk.Type;

/** A Magnesium pod's settings to change; what is left out stays as it is. */
export const EditPodAsk = Schema.Struct({
  server: HubMachineName,
  node: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  /** OpenCode's gateway and models; null leaves OpenCode unconfigured. */
  opencode: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        baseUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
        models: Schema.NonEmptyArray(Schema.String.check(Schema.isMinLength(1))),
      }),
    ),
  ),
  /** The model keys it gets, by name, all of them. */
  keys: Schema.optionalKey(Schema.Array(Schema.String)),
  summary: Summary,
});
export type EditPodAsk = typeof EditPodAsk.Type;

/** A request as kept: which change, and its details. */
export const FleetRequestInput = Schema.Union([
  Schema.TaggedStruct("update", FleetServerAsk.fields),
  Schema.TaggedStruct("rollback", FleetServerAsk.fields),
  Schema.TaggedStruct("backup-now", FleetServerAsk.fields),
  Schema.TaggedStruct("restore", RestoreBackupAsk.fields),
  Schema.TaggedStruct("add-machine", AddMachineAsk.fields),
  Schema.TaggedStruct("forget-machine", ForgetMachineAsk.fields),
  Schema.TaggedStruct("edit-pod", EditPodAsk.fields),
]);
export type FleetRequestInput = typeof FleetRequestInput.Type;

export const FleetRequest = Schema.Struct({
  id: Schema.String,
  /** The thread whose agent asked, when it asked from one. */
  threadId: Schema.NullOr(Schema.String),
  /** The asking agent's profile, or its harness when it runs on none. */
  requestedBy: Schema.String,
  input: FleetRequestInput,
  createdAt: Schema.String,
  decision: Schema.NullOr(Schema.Literals(["approved", "rejected"])),
  /** What happened once approved, or why it was turned down. */
  note: Schema.NullOr(Schema.String),
});
export type FleetRequest = typeof FleetRequest.Type;

export const FleetRequestIdInput = Schema.Struct({ id: Schema.String });
export type FleetRequestIdInput = typeof FleetRequestIdInput.Type;

export const FleetServerInputForAgents = Schema.Struct({ server: Server });
export type FleetServerInputForAgents = typeof FleetServerInputForAgents.Type;

/** Every server this one reaches, as Fleet shows it. */
export const FleetMachineList = Schema.Struct({ servers: Schema.Array(FleetMachine) });
export type FleetMachineList = typeof FleetMachineList.Type;

/** A request's server, as a card names it: its name, or this server when it was left out. */
export const fleetRequestTarget = (input: FleetRequestInput): string | null =>
  input._tag === "add-machine" ? input.name : (input.server ?? null);

/** What a request asks, in a few words for a card, naming `here` when it is about this server. */
export const describeFleetRequest = (input: FleetRequestInput, here: string): string => {
  const target = fleetRequestTarget(input) ?? here;
  switch (input._tag) {
    case "update":
      return `Update ${target} to the hub's build`;
    case "rollback":
      return `Roll ${target} back to its build before`;
    case "backup-now":
      return `Back up ${target} now`;
    case "restore":
      return `Restore ${target} from ${input.backup}`;
    case "add-machine":
      return `Add ${input.name} at ${input.url} to Fleet`;
    case "forget-machine":
      return `Forget ${target}`;
    case "edit-pod": {
      const changes = [
        input.node === undefined ? null : `node ${input.node}`,
        input.opencode === undefined
          ? null
          : input.opencode === null
            ? "no OpenCode"
            : `OpenCode at ${input.opencode.baseUrl} with ${input.opencode.models.join(", ")}`,
        input.keys === undefined
          ? null
          : `keys ${input.keys.length === 0 ? "none" : input.keys.join(", ")}`,
      ].filter((change) => change !== null);
      return `Edit ${target}'s pod: ${changes.length === 0 ? "nothing" : changes.join("; ")}`;
    }
  }
};
