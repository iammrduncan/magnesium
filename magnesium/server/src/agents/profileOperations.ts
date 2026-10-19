import {
  CreateProfileAsk,
  DeleteProfileAsk,
  MAGNESIUM_AGENT_TOOLS,
  type MagnesiumAgentToolName,
  ProfileDetail,
  type ProfileError,
  ProfileNameInput,
  ProfileRequest,
  type ProfileRequestInput,
  ProfileRequestIdInput,
  ProfileSendResult,
  UpdateProfileAsk,
} from "@magnesium/contracts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { MagnesiumAgentTools } from "./MagnesiumAgentTools.ts";
import { AgentInputError, type AgentOperation, badInput, EMPTY_OBJECT } from "./operations.ts";

/**
 * The agents API's profile operations that need the running server (goal 34):
 * the same tools a thread has, for agents outside Magnesium. An ask made here
 * comes from no thread, so Home says an agent outside Magnesium asked.
 */

const refused = (error: ProfileError) => new AgentInputError({ message: error.detail });

const operation = <I, IE, O, OE>(spec: {
  readonly name: MagnesiumAgentToolName;
  readonly path: string;
  readonly method?: "POST";
  readonly scope: AuthEnvironmentScope;
  readonly input: Schema.Codec<I, IE>;
  /** For an input with no fields: an empty Struct's JSON Schema isn't an MCP object schema. */
  readonly inputSchema?: Record<string, unknown>;
  readonly output: Schema.Codec<O, OE>;
  readonly fromQuery?: (query: URLSearchParams) => unknown;
  readonly run: (input: I) => Effect.Effect<O, ProfileError, MagnesiumAgentTools>;
}): AgentOperation<MagnesiumAgentTools> => {
  const decode = Schema.decodeUnknownEffect(spec.input);
  const encode = Schema.encodeEffect(spec.output);
  return {
    name: spec.name,
    description: MAGNESIUM_AGENT_TOOLS[spec.name].description,
    path: spec.path,
    ...(spec.method === undefined ? {} : { method: spec.method }),
    scope: spec.scope,
    inputSchema:
      spec.inputSchema ?? (Tool.getJsonSchemaFromSchema(spec.input) as Record<string, unknown>),
    fromQuery: spec.fromQuery ?? (() => ({})),
    run: (raw) =>
      decode(raw ?? {}).pipe(
        Effect.mapError(badInput),
        Effect.flatMap((input) => spec.run(input).pipe(Effect.mapError(refused))),
        Effect.flatMap((result) => encode(result).pipe(Effect.orDie)),
      ),
  };
};

const withTools = <A, E>(use: (tools: MagnesiumAgentTools["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* MagnesiumAgentTools);
  });

const ask = (input: ProfileRequestInput) =>
  withTools((tools) => tools.requestProfileChange(input, null));

export const profileOperations: ReadonlyArray<AgentOperation<MagnesiumAgentTools>> = [
  operation({
    name: "get_profile",
    path: "/profile",
    scope: AuthOrchestrationReadScope,
    input: ProfileNameInput,
    output: ProfileDetail,
    fromQuery: (query) => ({ name: query.get("name") ?? "" }),
    run: ({ name }) => withTools((tools) => tools.getProfile(name)),
  }),
  operation({
    name: "create_profile",
    path: "/profiles/create",
    method: "POST",
    scope: AuthOrchestrationOperateScope,
    input: CreateProfileAsk,
    output: ProfileRequest,
    run: (input) => ask({ kind: "create", ...input }),
  }),
  operation({
    name: "update_profile",
    path: "/profiles/update",
    method: "POST",
    scope: AuthOrchestrationOperateScope,
    input: UpdateProfileAsk,
    output: ProfileRequest,
    run: (input) => ask({ kind: "update", ...input }),
  }),
  operation({
    name: "delete_profile",
    path: "/profiles/delete",
    method: "POST",
    scope: AuthOrchestrationOperateScope,
    input: DeleteProfileAsk,
    output: ProfileRequest,
    run: (input) => ask({ kind: "delete", ...input }),
  }),
  operation({
    name: "profile_request_status",
    path: "/profile-requests",
    scope: AuthOrchestrationReadScope,
    input: ProfileRequestIdInput,
    output: ProfileRequest,
    fromQuery: (query) => ({ id: query.get("id") ?? "" }),
    run: ({ id }) => withTools((tools) => tools.profileRequest(id)),
  }),
  operation({
    name: "send_profile_now",
    path: "/profiles/send",
    method: "POST",
    scope: AuthOrchestrationOperateScope,
    input: Schema.Struct({}),
    inputSchema: EMPTY_OBJECT,
    output: ProfileSendResult,
    run: () => withTools((tools) => tools.sendNow),
  }),
];
