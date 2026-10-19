import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/http";

import { agentsRoutesLayer } from "../agents/routes.ts";
import { HubMachines } from "../hub/HubMachines.ts";
import { machineSandboxesRoute } from "./hubRoutes.ts";
import { ServerPorts } from "../ports.ts";
import { InstanceSource, ProfilesConfig } from "./catalog.ts";
import * as HubProfilePusher from "./HubProfilePusher.ts";
import * as ProfileStore from "./ProfileStore.ts";
import * as ProfileSync from "./ProfileSync.ts";
import { detectSetup, wrapperCandidates } from "./setup.ts";

/**
 * Profiles and sandboxes on this server (goal 03): what the machine can run,
 * profile sync, the hub's push, and the agents API's REST and MCP routes. The
 * RPC handlers are in `rpcHandlers.ts`.
 */

const configLayer = Layer.effect(
  ProfilesConfig,
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const detected = yield* detectSetup({
      env: process.env,
      baseDir: ports.baseDir,
      wrapperCandidates: yield* wrapperCandidates,
      serverPort: ports.port,
    });
    yield* Effect.logInfo("Agents on this server run fenced by default.", {
      machine: detected.machine,
      fence: detected.setup.fence,
      container: detected.setup.container,
    });
    return ProfilesConfig.of(detected);
  }),
);

const instanceSourceLayer = Layer.effect(
  InstanceSource,
  Effect.map(ServerPorts, (ports) =>
    InstanceSource.of({
      instances: ports.getSettings.pipe(
        Effect.map((settings) => settings.providerInstances),
        Effect.orElseSucceed(() => ({})),
      ),
    }),
  ),
);

/**
 * The profile services: config, sync, the hub's push, and the store the app
 * changes profiles through. Needs `ServerPorts`, `HubMachines` and `Fleet`.
 */
export const profileServicesLayer = ProfileStore.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(ProfileSync.layer, HubProfilePusher.layer)),
  Layer.provideMerge(Layer.merge(configLayer, instanceSourceLayer)),
);

const routesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ProfilesConfig
      | InstanceSource
      | ServerPorts
      | HubMachines
      | HttpClient.HttpClient
    >();
    return Layer.merge(agentsRoutesLayer, machineSandboxesRoute).pipe(
      HttpRouter.provideRequest(Layer.succeedContext(context)),
    );
  }),
);

/** The agents API's routes, profile sync and the hub's push. Needs the profile services. */
export const profilesLayer = Layer.mergeAll(
  routesLayer,
  ProfileSync.workerLayer,
  HubProfilePusher.workerLayer,
);
