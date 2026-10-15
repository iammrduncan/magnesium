// Magnesium's server features: routes, workers and its own database (doc 11).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import * as HubMachines from "./hub/HubMachines.ts";
import { hubProxyRouteLayer } from "./hub/proxy.ts";
import { hubMachineRoutesLayer } from "./hub/routes.ts";
import { ServerPorts } from "./ports.ts";
import { sessionRenewRouteLayer } from "./session/renew.ts";

export * from "./ports.ts";

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

/** Every Magnesium route, plus the hub's token renewal. `apps/server` provides `ServerPorts`. */
export const routesLayer = Layer.mergeAll(routeLayers, HubMachines.renewalLayer).pipe(
  Layer.provide(HubMachines.layer),
);
