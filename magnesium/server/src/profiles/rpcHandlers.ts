import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { pushStatuses } from "../agents/operations.ts";
import { checkProfiles, listProfiles, listSandboxes } from "./catalog.ts";
import { ProfileSync } from "./ProfileSync.ts";
import { readRevision, receivePush } from "./receive.ts";

/**
 * Profiles and sandboxes on `/api/magnesium/ws` (goal 03): the same operations
 * the agents API serves over the CLI, REST and MCP, and the hub's push. Scopes
 * come from each RPC's `RequiredScope`, checked by the route.
 */

const withServices = Effect.fnUntraced(function* () {
  return yield* Effect.context<Effect.Services<ReturnType<typeof listSandboxes>> | ProfileSync>();
});

const listProfilesHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.listProfiles,
  Effect.gen(function* () {
    const context = yield* withServices();
    return () =>
      pushStatuses.pipe(Effect.flatMap(listProfiles), Effect.orDie, Effect.provideContext(context));
  }),
);

const checkProfilesHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.checkProfiles,
  Effect.gen(function* () {
    const context = yield* withServices();
    return (input) =>
      checkProfiles(input.names ?? []).pipe(Effect.orDie, Effect.provideContext(context));
  }),
);

const listSandboxesHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.listSandboxes,
  Effect.gen(function* () {
    const context = yield* withServices();
    return () => listSandboxes().pipe(Effect.orDie, Effect.provideContext(context));
  }),
);

const profileRevisionHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.profileRevision,
  Effect.gen(function* () {
    const context = yield* withServices();
    return () => readRevision.pipe(Effect.provideContext(context));
  }),
);

/** A machine takes the hub's push, then syncs at once so the picker shows it. */
const pushProfilesHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.pushProfiles,
  Effect.gen(function* () {
    const context = yield* withServices();
    const sync = yield* ProfileSync;
    return (push) =>
      receivePush(push).pipe(
        Effect.tap(() => sync.syncNow),
        Effect.orDie,
        Effect.provideContext(context),
      );
  }),
);

export const profileRpcHandlersLayer = Layer.mergeAll(
  listProfilesHandler,
  checkProfilesHandler,
  listSandboxesHandler,
  profileRevisionHandler,
  pushProfilesHandler,
);
