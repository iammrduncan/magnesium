import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HubSpokes } from "./HubSpokes.ts";
import { ModelKeys } from "./ModelKeys.ts";

/** The browser's RPCs for the hub's spokes and model keys; scopes are checked by the route. */

const listHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubSpokesList,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return () => spokes.list;
  }),
);

const applyHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubSpokesApply,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return (input) => spokes.apply(input);
  }),
);

const removeHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubSpokesRemove,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return (input) => spokes.remove(input);
  }),
);

const gatewaysHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubSpokesGateways,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return () => spokes.gateways;
  }),
);

const attachedHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubAttachedList,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return () => spokes.attached;
  }),
);

const attachHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubAttach,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return (input) => spokes.attach(input);
  }),
);

const detachHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.hubDetach,
  Effect.gen(function* () {
    const spokes = yield* HubSpokes;
    return (input) => spokes.detach(input);
  }),
);

const keysListHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.modelKeysList,
  Effect.gen(function* () {
    const keys = yield* ModelKeys;
    return () => keys.names;
  }),
);

const keysSetHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.modelKeysSet,
  Effect.gen(function* () {
    const keys = yield* ModelKeys;
    return (input) => keys.set(input.name, input.value);
  }),
);

const keysRemoveHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.modelKeysRemove,
  Effect.gen(function* () {
    const keys = yield* ModelKeys;
    return (input) => keys.remove(input.name);
  }),
);

export const hubSpokeHandlersLayer = Layer.mergeAll(
  listHandler,
  applyHandler,
  removeHandler,
  gatewaysHandler,
  attachedHandler,
  attachHandler,
  detachHandler,
  keysListHandler,
  keysSetHandler,
  keysRemoveHandler,
);
