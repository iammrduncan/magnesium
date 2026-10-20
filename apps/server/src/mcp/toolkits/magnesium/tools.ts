// magnesium: Magnesium's profile and Fleet tools on the per-thread MCP server (goals 34, 35; D65, D66)
import {
  AddMachineAsk,
  BackupList,
  CreateProfileAsk,
  DeleteProfileAsk,
  EditPodAsk,
  FleetMachineList,
  FleetRequest,
  FleetRequestIdInput,
  FleetServerAsk,
  FleetServerInputForAgents,
  ForgetMachineAsk,
  RestoreBackupAsk,
  MagnesiumAgentTools,
  MAGNESIUM_AGENT_TOOLS,
  ProfileCheckResult,
  ProfileDetail,
  ProfileList,
  ProfileNameInput,
  ProfileRequest,
  ProfileRequestIdInput,
  ProfileSendResult,
  UpdateProfileAsk,
} from "@magnesium/server";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// The names and descriptions are Magnesium's, shared with its agents API.
const reading = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, MagnesiumAgentTools],
};
// A tool that writes checks its caller, which needs the thread service.
const writing = {
  ...reading,
  dependencies: [...reading.dependencies, ThreadManagementService.ThreadManagementService],
};

const ListProfilesTool = Tool.make("list_profiles", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.list_profiles.description,
  // No `parameters`: an empty Schema.Struct isn't a valid MCP input schema (see worktree's tools).
  success: ProfileList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GetProfileTool = Tool.make("get_profile", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.get_profile.description,
  parameters: ProfileNameInput,
  success: ProfileDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CheckProfilesTool = Tool.make("check_profiles", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.check_profiles.description,
  parameters: Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) }),
  success: ProfileCheckResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ProfileRequestStatusTool = Tool.make("profile_request_status", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.profile_request_status.description,
  parameters: ProfileRequestIdInput,
  success: ProfileRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

// Asking writes nothing but the request; the owner approves every change.
const CreateProfileTool = Tool.make("create_profile", {
  ...writing,
  description: MAGNESIUM_AGENT_TOOLS.create_profile.description,
  parameters: CreateProfileAsk,
  success: ProfileRequest,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const UpdateProfileTool = Tool.make("update_profile", {
  ...writing,
  description: MAGNESIUM_AGENT_TOOLS.update_profile.description,
  parameters: UpdateProfileAsk,
  success: ProfileRequest,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const DeleteProfileTool = Tool.make("delete_profile", {
  ...writing,
  description: MAGNESIUM_AGENT_TOOLS.delete_profile.description,
  parameters: DeleteProfileAsk,
  success: ProfileRequest,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const SendProfileNowTool = Tool.make("send_profile_now", {
  ...writing,
  description: MAGNESIUM_AGENT_TOOLS.send_profile_now.description,
  success: ProfileSendResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// Fleet (goal 35): reading is free; every change is a request the owner approves.
const ListMachinesTool = Tool.make("list_machines", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.list_machines.description,
  success: FleetMachineList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ListBackupsTool = Tool.make("list_backups", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.list_backups.description,
  parameters: FleetServerInputForAgents,
  success: BackupList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FleetRequestStatusTool = Tool.make("fleet_request_status", {
  ...reading,
  description: MAGNESIUM_AGENT_TOOLS.fleet_request_status.description,
  parameters: FleetRequestIdInput,
  success: FleetRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const fleetAsk = <
  const N extends
    | "update_server"
    | "rollback_server"
    | "backup_now"
    | "restore_backup"
    | "add_machine"
    | "forget_machine"
    | "edit_pod",
  S extends Schema.Top,
>(
  name: N,
  parameters: S,
) =>
  Tool.make(name, {
    ...writing,
    description: MAGNESIUM_AGENT_TOOLS[name].description,
    parameters,
    success: FleetRequest,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false);

const UpdateServerTool = fleetAsk("update_server", FleetServerAsk);
const RollbackServerTool = fleetAsk("rollback_server", FleetServerAsk);
const BackupNowTool = fleetAsk("backup_now", FleetServerAsk);
const RestoreBackupTool = fleetAsk("restore_backup", RestoreBackupAsk);
const AddMachineTool = fleetAsk("add_machine", AddMachineAsk);
const ForgetMachineTool = fleetAsk("forget_machine", ForgetMachineAsk);
const EditPodTool = fleetAsk("edit_pod", EditPodAsk);

export const MagnesiumToolkit = Toolkit.make(
  ListProfilesTool,
  GetProfileTool,
  CheckProfilesTool,
  CreateProfileTool,
  UpdateProfileTool,
  DeleteProfileTool,
  ProfileRequestStatusTool,
  SendProfileNowTool,
  ListMachinesTool,
  ListBackupsTool,
  UpdateServerTool,
  RollbackServerTool,
  BackupNowTool,
  RestoreBackupTool,
  AddMachineTool,
  ForgetMachineTool,
  EditPodTool,
  FleetRequestStatusTool,
);
