import { AGENTS_API_PATH, AGENTS_MCP_PATH } from "@magnesium/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerPorts } from "../ports.ts";
import { MagnesiumAgentTools } from "./MagnesiumAgentTools.ts";
import { type AgentOperation, type AgentServices, operations } from "./operations.ts";
import { profileOperations } from "./profileOperations.ts";

/**
 * The agents API over HTTP: REST and MCP, for agents and tools outside the web
 * UI (which uses `/api/magnesium/ws`). Any signed-in session with the
 * operation's scope may call it. The operations that change something only
 * ask: the owner approves each change on Home.
 */

const served: ReadonlyArray<AgentOperation<AgentServices | MagnesiumAgentTools>> = [
  ...operations,
  ...profileOperations,
];
const findOperation = (name: string) => served.find((operation) => operation.name === name);

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

/** The caller's scopes, or a 401 response. */
const callerScopes = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ports = yield* ServerPorts;
  const caller = yield* ports.authenticate(request).pipe(Effect.option);
  return Option.map(caller, (session) => session.scopes);
});

const withScope = <E, R>(
  scope: AuthEnvironmentScope,
  onAllowed: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const scopes = yield* callerScopes;
    if (Option.isNone(scopes)) return jsonError(401, "Sign in first.");
    if (!scopes.value.includes(scope)) return jsonError(403, `This needs the ${scope} scope.`);
    return yield* onAllowed;
  });

/** REST: one route per agents-API operation. */
const restRoutes = served
  .map((operation) =>
    HttpRouter.add(
      operation.method ?? "GET",
      `${AGENTS_API_PATH}${operation.path}`,
      withScope(
        operation.scope,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input =
            operation.method === "POST"
              ? yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
              : operation.fromQuery(new URL(request.url, "http://local").searchParams);
          return yield* operation.run(input).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
            Effect.catchTags({
              AgentInputError: (error) => Effect.succeed(jsonError(400, error.message)),
            }),
          );
        }),
      ),
    ),
  )
  .reduce((all, route) => Layer.merge(all, route));

const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeToolCall = Schema.decodeUnknownEffect(ToolCallParams);
const ProtocolVersion = Schema.Struct({ protocolVersion: Schema.String });
const decodeProtocolVersion = Schema.decodeUnknownEffect(ProtocolVersion);

/**
 * MCP over Streamable HTTP, JSON responses only: initialize, ping, tools/list and
 * tools/call, one tool per operation. Behind the same sign-in and scopes as REST.
 */
const mcpRoute = HttpRouter.add(
  "POST",
  AGENTS_MCP_PATH,
  Effect.gen(function* () {
    const scopes = yield* callerScopes;
    if (Option.isNone(scopes)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Sign in first." },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    const message = yield* HttpServerRequest.schemaBodyJson(JsonRpcRequest).pipe(Effect.option);
    if (Option.isNone(message)) {
      return HttpServerResponse.jsonUnsafe({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Not a JSON-RPC 2.0 request." },
      });
    }
    const { id, method, params } = message.value;
    // Notifications (notifications/initialized and friends) get no reply.
    if (id === undefined) return HttpServerResponse.empty({ status: 202 });
    const reply = (result: unknown) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) =>
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, error: { code, message: text } });
    switch (method) {
      case "initialize": {
        const version = yield* decodeProtocolVersion(params).pipe(Effect.option);
        return reply({
          protocolVersion: Option.match(version, {
            onNone: () => "2025-06-18",
            onSome: (value) => value.protocolVersion,
          }),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "magnesium-agents", version: "0.1.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: served
            .filter((operation) => scopes.value.includes(operation.scope))
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const call = yield* decodeToolCall(params).pipe(Effect.option);
        const operation = Option.flatMap(call, (value) =>
          Option.fromNullishOr(findOperation(value.name)),
        );
        if (Option.isNone(call) || Option.isNone(operation)) return fail(-32602, "Unknown tool.");
        if (!scopes.value.includes(operation.value.scope)) {
          return reply({
            content: [{ type: "text", text: `This needs the ${operation.value.scope} scope.` }],
            isError: true,
          });
        }
        return yield* operation.value.run(call.value.arguments).pipe(
          Effect.map((result) =>
            reply({
              content: [{ type: "text", text: encodeJson(result) }],
              structuredContent: result,
              isError: false,
            }),
          ),
          Effect.catchTags({
            AgentInputError: (error) =>
              Effect.succeed(
                reply({ content: [{ type: "text", text: error.message }], isError: true }),
              ),
          }),
        );
      }
      default:
        return fail(-32601, `Method ${method} not found.`);
    }
  }),
);

export const agentsRoutesLayer = Layer.merge(restRoutes, mcpRoute);
