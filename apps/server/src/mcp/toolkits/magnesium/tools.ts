// magnesium: Magnesium's profile tools on the per-thread MCP server (goal 34, D65)
import {
  CreateProfileAsk,
  DeleteProfileAsk,
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

export const MagnesiumToolkit = Toolkit.make(
  ListProfilesTool,
  GetProfileTool,
  CheckProfilesTool,
  CreateProfileTool,
  UpdateProfileTool,
  DeleteProfileTool,
  ProfileRequestStatusTool,
  SendProfileNowTool,
);
