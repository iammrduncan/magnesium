import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { pushStatuses } from "../agents/operations.ts";
import { checkProfiles, listProfiles, listSandboxes } from "./catalog.ts";
import { ProfileStore } from "./ProfileStore.ts";
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

/**
 * Profiles changed from the app (goal 34). The browser speaks for the owner, so
 * its changes are "You" in a profile's history.
 */
const OWNER = "You";

const storeHandlers = Layer.mergeAll(
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileDetail,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (input) => store.detail(input.name);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileSave,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (change) => store.save(change, OWNER);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileCreate,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (input) => store.create(input, OWNER);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileRemove,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (input) => store.remove(input.name, OWNER);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileDeleted,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return () => store.deleted;
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileRestore,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (input) => store.restore(input.name, OWNER);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profilePutBack,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return (input) => store.putBack(input, OWNER);
    }),
  ),
  MagnesiumRpcGroup.toLayerHandler(
    MAGNESIUM_WS_METHODS.profileSendNow,
    Effect.gen(function* () {
      const store = yield* ProfileStore;
      return () => store.sendNow;
    }),
  ),
);

export const profileRpcHandlersLayer = Layer.mergeAll(
  storeHandlers,
  listProfilesHandler,
  checkProfilesHandler,
  listSandboxesHandler,
  profileRevisionHandler,
  pushProfilesHandler,
);
