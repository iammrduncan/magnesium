import {
  AddMachineAsk,
  BackupList,
  EditPodAsk,
  FleetMachineList,
  FleetRequest,
  FleetRequestIdInput,
  type FleetRequestInput,
  FleetServerAsk,
  FleetServerInputForAgents,
  ForgetMachineAsk,
  RestoreBackupAsk,
} from "@magnesium/contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MagnesiumAgentTools } from "./MagnesiumAgentTools.ts";
import { type AgentOperation, EMPTY_OBJECT } from "./operations.ts";
import { operation } from "./profileOperations.ts";

/**
 * The agents API's Fleet operations (goal 35, D66): the same tools a thread
 * has, for agents outside Magnesium. Reading is free; every change is a request
 * the owner approves on Home, so these need only the operate scope.
 */

const withTools = <A, E>(use: (tools: MagnesiumAgentTools["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* MagnesiumAgentTools);
  });

const ask = (input: FleetRequestInput) =>
  withTools((tools) => tools.requestFleetChange(input, null));

const asking = <I, IE>(
  name:
    | "update_server"
    | "rollback_server"
    | "backup_now"
    | "restore_backup"
    | "add_machine"
    | "forget_machine"
    | "edit_pod",
  path: string,
  input: Schema.Codec<I, IE>,
  toRequest: (input: I) => FleetRequestInput,
) =>
  operation({
    name,
    path,
    method: "POST",
    scope: AuthOrchestrationOperateScope,
    input,
    output: FleetRequest,
    run: (given) => ask(toRequest(given)),
  });

export const fleetOperations: ReadonlyArray<AgentOperation<MagnesiumAgentTools>> = [
  operation({
    name: "list_machines",
    path: "/fleet",
    scope: AuthOrchestrationReadScope,
    input: Schema.Struct({}),
    inputSchema: EMPTY_OBJECT,
    output: FleetMachineList,
    run: () => withTools((tools) => tools.listMachines),
  }),
  operation({
    name: "list_backups",
    path: "/fleet/backups",
    scope: AuthOrchestrationReadScope,
    input: FleetServerInputForAgents,
    output: BackupList,
    fromQuery: (query) => {
      const server = query.get("server");
      return server === null ? {} : { server };
    },
    run: ({ server }) => withTools((tools) => tools.listBackups(server ?? null)),
  }),
  asking("update_server", "/fleet/update", FleetServerAsk, (input) => ({
    _tag: "update",
    ...input,
  })),
  asking("rollback_server", "/fleet/rollback", FleetServerAsk, (input) => ({
    _tag: "rollback",
    ...input,
  })),
  asking("backup_now", "/fleet/backup", FleetServerAsk, (input) => ({
    _tag: "backup-now",
    ...input,
  })),
  asking("restore_backup", "/fleet/restore", RestoreBackupAsk, (input) => ({
    _tag: "restore",
    ...input,
  })),
  asking("add_machine", "/fleet/machines/add", AddMachineAsk, (input) => ({
    _tag: "add-machine",
    ...input,
  })),
  asking("forget_machine", "/fleet/machines/forget", ForgetMachineAsk, (input) => ({
    _tag: "forget-machine",
    ...input,
  })),
  asking("edit_pod", "/fleet/pods/edit", EditPodAsk, (input) => ({ _tag: "edit-pod", ...input })),
  operation({
    name: "fleet_request_status",
    path: "/fleet-requests",
    scope: AuthOrchestrationReadScope,
    input: FleetRequestIdInput,
    output: FleetRequest,
    fromQuery: (query) => ({ id: query.get("id") ?? "" }),
    run: ({ id }) => withTools((tools) => tools.fleetRequest(id)),
  }),
];
