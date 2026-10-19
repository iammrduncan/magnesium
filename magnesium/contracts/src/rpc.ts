import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

import { FleetEvent, FleetMachine, FleetReconnectInput } from "./fleet.ts";
import { HubMachineName } from "./hub.ts";
import { FooterItem } from "./footer.ts";
import {
  HomeAnswerError,
  HomeAnswerInput,
  HomeDetail,
  HomeDetailInput,
  HomeItem,
  HomePinInput,
  HomeSummary,
  LocalAnswerInput,
  LocalDetailInput,
  LocalHomeItem,
} from "./home.ts";
import {
  DeletedProfile,
  EnvPresence,
  EnvPresenceInput,
  ProfileChange,
  ProfileCheckResult,
  ProfileCreateInput,
  ProfileDetail,
  ProfileEnvironment,
  ProfileError,
  ProfileList,
  ProfileNameInput,
  ProfilePush,
  ProfilePushResult,
  ProfilePutBackInput,
  ProfileRequest,
  ProfileRequestIdInput,
  ProfileRevision,
  ProfileSaveResult,
  SandboxList,
} from "./profiles.ts";
import {
  GatewayAttached,
  GatewayAttachedPairedInput,
  HubAttached,
  HubAttachInput,
  HubDetachInput,
  HubSpoke,
  HubSpokeApplyInput,
  ModelKeyName,
  ModelKeyRemoveInput,
  ModelKeySetInput,
  SpokeApplyInput,
  SpokeError,
  SpokeRemoveInput,
  SpokeStatus,
} from "./spokes.ts";
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

/**
 * How long a client waits for any frame before it drops the socket. Effect's
 * client pings every 5 seconds and by default allows only one interval, so on
 * a fast link it drops a healthy socket every 10 seconds; upstream's clients
 * allow 15 seconds for the same reason.
 */
export const MAGNESIUM_PING_TIMEOUT = "15 seconds";

export const MAGNESIUM_WS_METHODS = {
  ping: "magnesium.ping",
  serverStatus: "magnesium.server.status",
  fleetMachines: "magnesium.fleet.machines",
  fleetEvents: "magnesium.fleet.events",
  fleetEventHistory: "magnesium.fleet.eventHistory",
  fleetReconnect: "magnesium.fleet.reconnect",
  footerItems: "magnesium.footer.items",
  listProfiles: "magnesium.profiles.list",
  checkProfiles: "magnesium.profiles.check",
  listSandboxes: "magnesium.sandboxes.list",
  profileRevision: "magnesium.profiles.revision",
  pushProfiles: "magnesium.profiles.push",
  profileDetail: "magnesium.profiles.detail",
  profileSave: "magnesium.profiles.save",
  profileCreate: "magnesium.profiles.create",
  profileRemove: "magnesium.profiles.remove",
  profileDeleted: "magnesium.profiles.deleted",
  profileRestore: "magnesium.profiles.restore",
  profilePutBack: "magnesium.profiles.putBack",
  profileSendNow: "magnesium.profiles.sendNow",
  profileEnvironment: "magnesium.profiles.environment",
  envPresence: "magnesium.profiles.envPresence",
  profileRequestGet: "magnesium.profiles.request",
  needsLocal: "magnesium.needs.local",
  needsAnswer: "magnesium.needs.answer",
  needsDetail: "magnesium.needs.detail",
  homeNeeds: "magnesium.home.needs",
  homeSummary: "magnesium.home.summary",
  homeAnswer: "magnesium.home.answer",
  homePin: "magnesium.home.pin",
  homeDetail: "magnesium.home.detail",
  spokesList: "magnesium.spokes.list",
  spokesApply: "magnesium.spokes.apply",
  spokesRemove: "magnesium.spokes.remove",
  hubSpokesList: "magnesium.hubSpokes.list",
  hubSpokesApply: "magnesium.hubSpokes.apply",
  hubSpokesRemove: "magnesium.hubSpokes.remove",
  hubSpokesGateways: "magnesium.hubSpokes.gateways",
  spokesAttached: "magnesium.spokes.attached",
  spokesAttachedPaired: "magnesium.spokes.attachedPaired",
  hubAttachedList: "magnesium.hubAttached.list",
  hubAttach: "magnesium.hubAttached.attach",
  hubDetach: "magnesium.hubAttached.detach",
  modelKeysList: "magnesium.modelKeys.list",
  modelKeysSet: "magnesium.modelKeys.set",
  modelKeysRemove: "magnesium.modelKeys.remove",
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

export const FooterItemsItem = liveTableItem(FooterItem);
export type FooterItemsItem = typeof FooterItemsItem.Type;

/** The footer's items, keyed by id, with labels the hub fills in (goal 05). */
const FooterItemsRpc = Rpc.make(MAGNESIUM_WS_METHODS.footerItems, {
  payload: StreamSubscribeInput,
  success: FooterItemsItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

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

// Profiles managed from the app (goal 34): read one whole, change it a file or a
// setting at a time, its history, and the trash. A change decides what agents run
// with, so it takes the scope a push does.
const ProfileDetailRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileDetail, {
  payload: ProfileNameInput,
  success: ProfileDetail,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
const ProfileSaveRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileSave, {
  payload: ProfileChange,
  success: ProfileSaveResult,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
const ProfileCreateRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileCreate, {
  payload: ProfileCreateInput,
  success: ProfileSaveResult,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
const ProfileRemoveRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileRemove, {
  payload: ProfileNameInput,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
const ProfileDeletedRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileDeleted, {
  payload: Schema.Struct({}),
  success: Schema.Array(DeletedProfile),
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
const ProfileRestoreRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileRestore, {
  payload: ProfileNameInput,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
const ProfilePutBackRpc = Rpc.make(MAGNESIUM_WS_METHODS.profilePutBack, {
  payload: ProfilePutBackInput,
  success: ProfileSaveResult,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
const ProfileSendNowRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileSendNow, {
  payload: Schema.Struct({}),
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
/** The hub asks the profile's machines which of its variables they have. */
const ProfileEnvironmentRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileEnvironment, {
  payload: ProfileNameInput,
  success: ProfileEnvironment,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);
/** The hub reads a request whole from the server it waits on, to apply it when approved. */
const ProfileRequestGetRpc = Rpc.make(MAGNESIUM_WS_METHODS.profileRequestGet, {
  payload: ProfileRequestIdInput,
  success: ProfileRequest,
  error: ProfileError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);
/** A machine says which variable names its server has set, never their values. */
const EnvPresenceRpc = Rpc.make(MAGNESIUM_WS_METHODS.envPresence, {
  payload: EnvPresenceInput,
  success: EnvPresence,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

// Home (goal 06). Each server's own items, which the hub follows on every machine,
// and the hub's gathered Home the browser shows.
export const LocalHomeItemsItem = liveTableItem(LocalHomeItem);
export type LocalHomeItemsItem = typeof LocalHomeItemsItem.Type;

/** This server's threads that wait on you or are working, keyed by `localHomeItemKey`. */
const NeedsLocalRpc = Rpc.make(MAGNESIUM_WS_METHODS.needsLocal, {
  payload: StreamSubscribeInput,
  success: LocalHomeItemsItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Answer one of this server's items in its thread. */
const NeedsAnswerRpc = Rpc.make(MAGNESIUM_WS_METHODS.needsAnswer, {
  payload: LocalAnswerInput,
  error: HomeAnswerError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

const NeedsDetailRpc = Rpc.make(MAGNESIUM_WS_METHODS.needsDetail, {
  payload: LocalDetailInput,
  success: HomeDetail,
  error: HomeAnswerError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

export const HomeItemsItem = liveTableItem(HomeItem);
export type HomeItemsItem = typeof HomeItemsItem.Type;

/** Every server's items with their machine and pin, keyed by `homeItemKey`. */
const HomeNeedsRpc = Rpc.make(MAGNESIUM_WS_METHODS.homeNeeds, {
  payload: StreamSubscribeInput,
  success: HomeItemsItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

export const HomeSummaryItem = liveTableItem(HomeSummary);
export type HomeSummaryItem = typeof HomeSummaryItem.Type;

const HomeSummaryRpc = Rpc.make(MAGNESIUM_WS_METHODS.homeSummary, {
  payload: StreamSubscribeInput,
  success: HomeSummaryItem,
  stream: true,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Answer an item on Home; the hub sends it to the thread on its machine. */
const HomeAnswerRpc = Rpc.make(MAGNESIUM_WS_METHODS.homeAnswer, {
  payload: HomeAnswerInput,
  error: HomeAnswerError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

const HomePinRpc = Rpc.make(MAGNESIUM_WS_METHODS.homePin, {
  payload: HomePinInput,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

/** An item's thread's latest work, for Detail. */
const HomeDetailRpc = Rpc.make(MAGNESIUM_WS_METHODS.homeDetail, {
  payload: HomeDetailInput,
  success: HomeDetail,
  error: HomeAnswerError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** A gateway's spokes, as its cluster sees them (goal 25). Other servers answer with an error. */
const SpokesListRpc = Rpc.make(MAGNESIUM_WS_METHODS.spokesList, {
  success: Schema.Array(SpokeStatus),
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Runs, changes or stops (`replicas: 0`) a spoke through its gateway. */
const SpokesApplyRpc = Rpc.make(MAGNESIUM_WS_METHODS.spokesApply, {
  payload: SpokeApplyInput,
  success: SpokeStatus,
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

/** Removes a spoke, keeping its volume unless told otherwise. */
const SpokesRemoveRpc = Rpc.make(MAGNESIUM_WS_METHODS.spokesRemove, {
  payload: SpokeRemoveInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

/** The spokes the hub runs through gateways, with each gateway's view (goal 25). */
const HubSpokesListRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubSpokesList, {
  success: Schema.Array(HubSpoke),
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Adds or changes a spoke; a new one pairs with the hub once it is up. Admins only. */
const HubSpokesApplyRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubSpokesApply, {
  payload: HubSpokeApplyInput,
  success: HubSpoke,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

const HubSpokesRemoveRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubSpokesRemove, {
  payload: SpokeRemoveInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

/** The hub's machines that are gateways: the ones that answer for their spokes. */
const HubSpokesGatewaysRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubSpokesGateways, {
  success: Schema.Array(HubMachineName),
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/**
 * The machines a gateway routes to inside workloads' pods (D59), with the
 * one-time codes of new ones: for the hub, with the same access it applies spokes with.
 */
const SpokesAttachedRpc = Rpc.make(MAGNESIUM_WS_METHODS.spokesAttached, {
  success: Schema.Array(GatewayAttached),
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

/** The hub has paired with an attached machine: mark its route and drop its spent code. */
const SpokesAttachedPairedRpc = Rpc.make(MAGNESIUM_WS_METHODS.spokesAttachedPaired, {
  payload: GatewayAttachedPairedInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationOperateScope);

/** The machines attached inside workloads' pods, reached through gateways (D59). */
const HubAttachedListRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubAttachedList, {
  success: Schema.Array(HubAttached),
  error: SpokeError,
}).annotate(RequiredScope, AuthOrchestrationReadScope);

/** Adds an attached machine, pairing with its code once it answers. Admins only. */
const HubAttachRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubAttach, {
  payload: HubAttachInput,
  success: HubAttached,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

/** Forgets an attached machine and the hub's access to it; the workload runs on. */
const HubDetachRpc = Rpc.make(MAGNESIUM_WS_METHODS.hubDetach, {
  payload: HubDetachInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

/** The names of the model keys the hub holds; their values never leave it except to a spoke. */
const ModelKeysListRpc = Rpc.make(MAGNESIUM_WS_METHODS.modelKeysList, {
  success: Schema.Array(ModelKeyName),
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

const ModelKeysSetRpc = Rpc.make(MAGNESIUM_WS_METHODS.modelKeysSet, {
  payload: ModelKeySetInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

const ModelKeysRemoveRpc = Rpc.make(MAGNESIUM_WS_METHODS.modelKeysRemove, {
  payload: ModelKeyRemoveInput,
  error: SpokeError,
}).annotate(RequiredScope, AuthAccessWriteScope);

export const MagnesiumRpcGroup = RpcGroup.make(
  PingRpc,
  ServerStatusRpc,
  FleetMachinesRpc,
  FleetEventsRpc,
  FleetEventHistoryRpc,
  FleetReconnectRpc,
  FooterItemsRpc,
  ListProfilesRpc,
  CheckProfilesRpc,
  ListSandboxesRpc,
  ProfileRevisionRpc,
  PushProfilesRpc,
  ProfileDetailRpc,
  ProfileSaveRpc,
  ProfileCreateRpc,
  ProfileRemoveRpc,
  ProfileDeletedRpc,
  ProfileRestoreRpc,
  ProfilePutBackRpc,
  ProfileSendNowRpc,
  ProfileEnvironmentRpc,
  EnvPresenceRpc,
  ProfileRequestGetRpc,
  NeedsLocalRpc,
  NeedsAnswerRpc,
  NeedsDetailRpc,
  HomeNeedsRpc,
  HomeSummaryRpc,
  HomeAnswerRpc,
  HomePinRpc,
  HomeDetailRpc,
  SpokesListRpc,
  SpokesApplyRpc,
  SpokesRemoveRpc,
  SpokesAttachedRpc,
  SpokesAttachedPairedRpc,
  HubSpokesListRpc,
  HubSpokesApplyRpc,
  HubSpokesRemoveRpc,
  HubSpokesGatewaysRpc,
  HubAttachedListRpc,
  HubAttachRpc,
  HubDetachRpc,
  ModelKeysListRpc,
  ModelKeysSetRpc,
  ModelKeysRemoveRpc,
).middleware(ScopeGuard);
export type MagnesiumRpcs = RpcGroup.Rpcs<typeof MagnesiumRpcGroup>;
export type MagnesiumRpcMethod = MagnesiumRpcs["_tag"];
