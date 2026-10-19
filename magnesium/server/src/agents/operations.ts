import {
  MAGNESIUM_AGENT_TOOLS,
  ProfileCheckResult,
  ProfileList,
  SandboxList,
} from "@magnesium/contracts";
import { AuthOrchestrationReadScope, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  checkProfiles,
  type InstanceSource,
  listProfiles,
  listSandboxes,
  type ProfilesConfig,
} from "../profiles/catalog.ts";
import { HubProfilePusher } from "../profiles/HubProfilePusher.ts";

/**
 * The Magnesium agents API (D37). Each operation
 * is written once here and served by the `magnesium-agents` CLI, by REST under
 * AGENTS_API_PATH, and as MCP tools at AGENTS_MCP_PATH. The web UI calls the
 * same functions over `/api/magnesium/ws`. Operations take JSON and return JSON,
 * encoded by the contract's schema.
 */

export class AgentInputError extends Schema.TaggedError<AgentInputError>()("AgentInputError", {
  message: Schema.String,
}) {}

export type AgentServices = FileSystem.FileSystem | Path.Path | ProfilesConfig | InstanceSource;

export interface AgentOperation<R = AgentServices> {
  readonly name: string;
  readonly description: string;
  /**
   * REST: `${AGENTS_API_PATH}${path}`. A GET takes its input from the query
   * string; a POST, which changes something, from its JSON body.
   */
  readonly path: string;
  readonly method?: "POST";
  readonly scope: AuthEnvironmentScope;
  /** JSON Schema of the input, for MCP's tools/list. */
  readonly inputSchema: Record<string, unknown>;
  readonly fromQuery: (query: URLSearchParams) => unknown;
  readonly run: (input: unknown) => Effect.Effect<unknown, AgentInputError, R>;
}

const NoInput = Schema.Struct({});
const CheckInput = Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) });
const decodeNoInput = Schema.decodeUnknownEffect(NoInput);
const decodeCheckInput = Schema.decodeUnknownEffect(CheckInput);
const encodeProfileList = Schema.encodeEffect(ProfileList);
const encodeCheckResult = Schema.encodeEffect(ProfileCheckResult);
const encodeSandboxList = Schema.encodeEffect(SandboxList);

export const badInput = (error: Schema.SchemaError) =>
  new AgentInputError({ message: error.message });
export const EMPTY_OBJECT = { type: "object", properties: {}, additionalProperties: false };

/** On the hub, what it last pushed to each machine. */
export const pushStatuses = Effect.serviceOption(HubProfilePusher).pipe(
  Effect.flatMap((pusher) => (pusher._tag === "Some" ? pusher.value.status : Effect.succeed([]))),
);

export const operations: ReadonlyArray<AgentOperation> = [
  {
    name: "list_profiles",
    description: MAGNESIUM_AGENT_TOOLS.list_profiles.description,
    path: "/profiles",
    scope: AuthOrchestrationReadScope,
    inputSchema: EMPTY_OBJECT,
    fromQuery: () => ({}),
    run: (input) =>
      Effect.gen(function* () {
        yield* decodeNoInput(input ?? {}).pipe(Effect.mapError(badInput));
        const list = yield* listProfiles(yield* pushStatuses);
        return yield* encodeProfileList(list).pipe(Effect.orDie);
      }),
  },
  {
    name: "check_profiles",
    description: MAGNESIUM_AGENT_TOOLS.check_profiles.description,
    path: "/profiles/check",
    scope: AuthOrchestrationReadScope,
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Only these profiles (default: every one).",
        },
      },
      additionalProperties: false,
    },
    fromQuery: (query) => {
      const names = query.getAll("name");
      return names.length > 0 ? { names } : {};
    },
    run: (input) =>
      Effect.gen(function* () {
        const { names } = yield* decodeCheckInput(input ?? {}).pipe(Effect.mapError(badInput));
        const result = yield* checkProfiles(names ?? []);
        return yield* encodeCheckResult(result).pipe(Effect.orDie);
      }),
  },
  {
    name: "list_sandboxes",
    description:
      "The sandbox levels this server can run (fenced, container, native, microvm), each with whether it is available, what enforces it, why not and how to enable it; and the level of every provider instance here.",
    path: "/sandboxes",
    scope: AuthOrchestrationReadScope,
    inputSchema: EMPTY_OBJECT,
    fromQuery: () => ({}),
    run: (input) =>
      Effect.gen(function* () {
        yield* decodeNoInput(input ?? {}).pipe(Effect.mapError(badInput));
        return yield* encodeSandboxList(yield* listSandboxes()).pipe(Effect.orDie);
      }),
  },
];

export const findOperation = (name: string) =>
  operations.find((operation) => operation.name === name);
