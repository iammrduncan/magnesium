// Magnesium's server features: routes, workers and its own database (doc 11).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as MagnesiumAgentTools from "./agents/MagnesiumAgentTools.ts";
import * as MagnesiumDb from "./db/MagnesiumDb.ts";
import * as Fleet from "./fleet/Fleet.ts";
import { fleetHandlersLayer } from "./fleet/handlers.ts";
import { footerHandlersLayer } from "./footer/handlers.ts";
import { gatewayConfigFromEnv, gatewayRouteLayer } from "./gateway/gateway.ts";
import { spokeHandlersLayer } from "./gateway/handlers.ts";
import { inClusterLayer } from "./gateway/kube.ts";
import * as Spokes from "./gateway/Spokes.ts";
import { homeHandlersLayer } from "./home/handlers.ts";
import * as Home from "./home/Home.ts";
import * as LocalHome from "./home/LocalHome.ts";
import * as HomeRelay from "./home/relay.ts";
import * as GatewayClient from "./hub/gatewayClient.ts";
import * as HubMachines from "./hub/HubMachines.ts";
import * as HubSpokes from "./hub/HubSpokes.ts";
import * as ModelKeys from "./hub/ModelKeys.ts";
import { hubProxyRouteLayer } from "./hub/proxy.ts";
import { hubMachineRoutesLayer } from "./hub/routes.ts";
import { hubSpokeHandlersLayer } from "./hub/spokeHandlers.ts";
import { ServerPorts } from "./ports.ts";
import { profileServicesLayer, profilesLayer } from "./profiles/layer.ts";
import { profileRpcHandlersLayer } from "./profiles/rpcHandlers.ts";
import { coreHandlersLayer } from "./rpc/handlers.ts";
import { magnesiumWsRouteLayer } from "./rpc/route.ts";
import { pairingCodeLayer } from "./session/pairingCode.ts";
import { sessionRenewRouteLayer } from "./session/renew.ts";
import { currentRelease } from "./status/release.ts";
import * as ServerStatus from "./status/ServerStatus.ts";

export * from "./ports.ts";
export { agentsCommand } from "./agents/cli.ts";
export { MagnesiumAgentTools } from "./agents/MagnesiumAgentTools.ts";
// The schemas upstream's MCP server needs to serve the agent tools above.
export {
  CreateProfileAsk,
  DeleteProfileAsk,
  MAGNESIUM_AGENT_TOOLS,
  ProfileCheckResult,
  ProfileDetail,
  ProfileError,
  ProfileList,
  ProfileNameInput,
  ProfileRequest,
  ProfileRequestIdInput,
  ProfileSendResult,
  UpdateProfileAsk,
} from "@magnesium/contracts";
export { RECENT_WORK_ITEM_TYPES } from "./home/items.ts";

const routeLayers = Layer.unwrap(
  Effect.gen(function* () {
    const machines = yield* HubMachines.HubMachines;
    const ports = yield* ServerPorts;
    // A gateway also passes the hub through to the spokes in its namespace (goal 25).
    const gateway = gatewayConfigFromEnv(process.env);
    return Layer.mergeAll(
      hubProxyRouteLayer,
      hubMachineRoutesLayer,
      sessionRenewRouteLayer,
      gateway === null ? Layer.empty : gatewayRouteLayer(gateway),
    ).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(HubMachines.HubMachines, machines),
          Layer.succeed(ServerPorts, ServerPorts.of(ports)),
        ),
      ),
    );
  }),
);

/** Handlers for every RPC on `/api/magnesium/ws`; each feature adds its own layer here. */
const rpcHandlersLayer = Layer.mergeAll(
  coreHandlersLayer,
  fleetHandlersLayer,
  footerHandlersLayer,
  homeHandlersLayer,
  profileRpcHandlersLayer,
  spokeHandlersLayer,
  hubSpokeHandlersLayer,
);

/** A gateway deploys spokes with its namespace's identity; other servers say they can't. */
const spokesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = gatewayConfigFromEnv(process.env);
    if (gateway === null) return Spokes.notAGatewayLayer;
    const release = yield* currentRelease;
    return Layer.effect(
      Spokes.Spokes,
      Spokes.make({
        image: gateway.image,
        defaultBuild: release ?? "unknown",
        storageClass: gateway.storageClass,
        timeZone: gateway.timeZone,
      }),
    ).pipe(Layer.provide(inClusterLayer));
  }),
);

/**
 * Every Magnesium route, plus its workers. `apps/server` provides `ServerPorts`.
 * It also hands out `MagnesiumAgentTools`, which upstream's per-thread MCP
 * server serves to agents (goal 34): built here, from the same services.
 */
export const routesLayer = Layer.mergeAll(
  routeLayers,
  MagnesiumAgentTools.layer,
  magnesiumWsRouteLayer.pipe(Layer.provide(rpcHandlersLayer)),
  HubMachines.renewalLayer,
  // The agents API serves the same agent tools, built once with the line above.
  profilesLayer.pipe(Layer.provide(MagnesiumAgentTools.layer)),
  pairingCodeLayer,
).pipe(
  Layer.provide(Home.layer),
  // Fleet tells the hub's spokes which machines are gateways, and its push
  // which machines are up and when each started.
  Layer.provide(HubSpokes.layer),
  // Home shows agents' profile requests, which the profile services keep.
  Layer.provide(LocalHome.layer),
  Layer.provide(profileServicesLayer),
  // Fleet carries each machine's Home items in the relay that Home reads.
  Layer.provide(Fleet.layer),
  Layer.provide(HomeRelay.layer),
  Layer.provide(spokesLayer),
  Layer.provide(Layer.mergeAll(GatewayClient.layer, ModelKeys.layer)),
  Layer.provide(Layer.mergeAll(HubMachines.layer, ServerStatus.layer)),
  Layer.provide(MagnesiumDb.layer),
);
