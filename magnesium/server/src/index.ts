// Magnesium's server features: routes, workers and its own database (doc 11).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as MagnesiumDb from "./db/MagnesiumDb.ts";
import * as Fleet from "./fleet/Fleet.ts";
import { fleetHandlersLayer } from "./fleet/handlers.ts";
import * as HubMachines from "./hub/HubMachines.ts";
import { hubProxyRouteLayer } from "./hub/proxy.ts";
import { hubMachineRoutesLayer } from "./hub/routes.ts";
import { ServerPorts } from "./ports.ts";
import { profileServicesLayer, profilesLayer } from "./profiles/layer.ts";
import { profileRpcHandlersLayer } from "./profiles/rpcHandlers.ts";
import { coreHandlersLayer } from "./rpc/handlers.ts";
import { magnesiumWsRouteLayer } from "./rpc/route.ts";
import { sessionRenewRouteLayer } from "./session/renew.ts";
import * as ServerStatus from "./status/ServerStatus.ts";

export * from "./ports.ts";
export { agentsCommand } from "./agents/cli.ts";

const routeLayers = Layer.unwrap(
  Effect.gen(function* () {
    const machines = yield* HubMachines.HubMachines;
    const ports = yield* ServerPorts;
    return Layer.mergeAll(hubProxyRouteLayer, hubMachineRoutesLayer, sessionRenewRouteLayer).pipe(
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
  profileRpcHandlersLayer,
);

/** Every Magnesium route, plus its workers. `apps/server` provides `ServerPorts`. */
export const routesLayer = Layer.mergeAll(
  routeLayers,
  magnesiumWsRouteLayer.pipe(Layer.provide(rpcHandlersLayer)),
  HubMachines.renewalLayer,
  profilesLayer,
).pipe(
  Layer.provide(Fleet.layer),
  Layer.provide(profileServicesLayer),
  Layer.provide(Layer.mergeAll(HubMachines.layer, ServerStatus.layer)),
  Layer.provide(MagnesiumDb.layer),
);
