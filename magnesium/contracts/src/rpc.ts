import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { FleetEvent, FleetMachine, FleetReconnectInput } from "./fleet.ts";
import {
  ProfileCheckResult,
  ProfileList,
  ProfilePush,
  ProfilePushResult,
  ProfileRevision,
  SandboxList,
} from "./profiles.ts";
import { PingResult, ServerStatus } from "./status.ts";
import {
  historyPage,
  liveLogItem,
  liveTableItem,
  StreamHistoryInput,
  StreamSubscribeInput,
} from "./stream.ts";

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
  fleetMachines: "magnesium.fleet.machines",
  fleetEvents: "magnesium.fleet.events",
  fleetEventHistory: "magnesium.fleet.eventHistory",
  fleetReconnect: "magnesium.fleet.reconnect",
  listProfiles: "magnesium.profiles.list",
  checkProfiles: "magnesium.profiles.check",
  listSandboxes: "magnesium.sandboxes.list",
  profileRevision: "magnesium.profiles.revision",
  pushProfiles: "magnesium.profiles.push",
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

export const FleetMachinesItem = liveTableItem(FleetMachine);
export type FleetMachinesItem = typeof FleetMachinesItem.Type;

/** Every server the hub reaches, keyed by `fleetMachineKey`. */
const FleetMachinesRpc = Rpc.make(MAGNESIUM_WS_METHODS.fleetMachines, {
  payload: StreamSubscribeInput,
  success: FleetMachinesItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

export const FleetEventsItem = liveLogItem(FleetEvent);
export type FleetEventsItem = typeof FleetEventsItem.Type;

/** Links coming up and going down, newest last. */
const FleetEventsRpc = Rpc.make(MAGNESIUM_WS_METHODS.fleetEvents, {
  payload: StreamSubscribeInput,
  success: FleetEventsItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

const FleetEventHistoryRpc = Rpc.make(MAGNESIUM_WS_METHODS.fleetEventHistory, {
  payload: StreamHistoryInput,
  success: historyPage(FleetEvent),
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Try a machine's link now instead of waiting out the backoff. */
const FleetReconnectRpc = Rpc.make(MAGNESIUM_WS_METHODS.fleetReconnect, {
  payload: FleetReconnectInput,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

// Profiles and sandboxes (goal 03). The agents API's list_profiles, check_profiles and
// list_sandboxes, and the hub's push of each machine's profiles (D39).
const ListProfilesRpc = Rpc.make(MAGNESIUM_WS_METHODS.listProfiles, {
  payload: Schema.Struct({}),
  success: ProfileList,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
const CheckProfilesRpc = Rpc.make(MAGNESIUM_WS_METHODS.checkProfiles, {
  payload: Schema.Struct({ names: Schema.optionalKey(Schema.Array(Schema.String)) }),
  success: ProfileCheckResult,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
const ListSandboxesRpc = Rpc.make(MAGNESIUM_WS_METHODS.listSandboxes, {
  payload: Schema.Struct({}),
  success: SandboxList,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
const ProfileRevisionRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileRevision, {
  payload: Schema.Struct({}),
  success: ProfileRevision,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
/** A push decides what runs here: the scope that already edits provider instances. */
const PushProfilesRpc = Rpc.make(MAGNESIUM_WS_METHODS.pushProfiles, {
  payload: ProfilePush,
  success: ProfilePushResult,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

export const MagnesiumRpcGroup = RpcGroup.make(
  PingRpc,
  ServerStatusRpc,
  FleetMachinesRpc,
  FleetEventsRpc,
  FleetEventHistoryRpc,
  FleetReconnectRpc,
  ListProfilesRpc,
  CheckProfilesRpc,
  ListSandboxesRpc,
  ProfileRevisionRpc,
  PushProfilesRpc,
).middleware(ScopeGuard);
export type MagnesiumRpcs = RpcGroup.Rpcs<typeof MagnesiumRpcGroup>;
export type MagnesiumRpcMethod = MagnesiumRpcs["_tag"];
