import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { PingResult, ServerStatus } from "./status.ts";
import { liveTableItem, StreamSubscribeInput } from "./stream.ts";

/**
 * Magnesium's own RPC route, next to upstream's `/ws` and with the same auth
 * and scopes (doc 11). It sits under `/api` so every front door and the dev
 * proxy already carry it, WebSocket upgrades included, as the hub's machine
 * routes do. The hub's proxy never forwards it to a machine: browsers talk to
 * the hub's own route, and the hub talks to each machine's.
 */
export const MAGNESIUM_WS_PATH = "/api/magnesium/ws";

export const MAGNESIUM_WS_METHODS = {
  ping: "magnesium.ping",
  serverStatus: "magnesium.server.status",
} as const;

/**
 * The scope a caller needs for an RPC, from upstream's scopes. Every RPC in
 * the group carries one; the server refuses an RPC without it.
 */
export class RequiredScope extends Context.Service<RequiredScope, AuthEnvironmentScope>()(
  "@magnesium/contracts/rpc/RequiredScope",
) {}

/** Checks each call against its `RequiredScope`; the server provides it per connection. */
export class ScopeGuard extends RpcMiddleware.Service<ScopeGuard>()(
  "@magnesium/contracts/rpc/ScopeGuard",
  { error: EnvironmentAuthorizationError },
) {}

const PingRpc = Rpc.make(MAGNESIUM_WS_METHODS.ping, {
  payload: Schema.Struct({}),
  success: PingResult,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

export const ServerStatusItem = liveTableItem(ServerStatus);
export type ServerStatusItem = typeof ServerStatusItem.Type;

/** This server's status, as a one-row table keyed by its environment id. */
const ServerStatusRpc = Rpc.make(MAGNESIUM_WS_METHODS.serverStatus, {
  payload: StreamSubscribeInput,
  success: ServerStatusItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

export const MagnesiumRpcGroup = RpcGroup.make(PingRpc, ServerStatusRpc).middleware(ScopeGuard);
export type MagnesiumRpcs = RpcGroup.Rpcs<typeof MagnesiumRpcGroup>;
export type MagnesiumRpcMethod = MagnesiumRpcs["_tag"];
