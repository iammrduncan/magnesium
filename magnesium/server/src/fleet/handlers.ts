import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Fleet } from "./Fleet.ts";

/** Handlers for Fleet's RPCs; scopes are checked by the route. */

const machinesHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetMachines,
  Effect.gen(function* () {
    const fleet = yield* Fleet;
    return (input) => fleet.subscribeMachines(input);
  }),
);

const eventsHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetEvents,
  Effect.gen(function* () {
    const fleet = yield* Fleet;
    return (input) => fleet.subscribeEvents(input);
  }),
);

const eventHistoryHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetEventHistory,
  Effect.gen(function* () {
    const fleet = yield* Fleet;
    return (input) => fleet.eventHistory(input);
  }),
);

const reconnectHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetReconnect,
  Effect.gen(function* () {
    const fleet = yield* Fleet;
    return (input) => fleet.reconnect(input.name);
  }),
);

export const fleetHandlersLayer = Layer.mergeAll(
  machinesHandler,
  eventsHandler,
  eventHistoryHandler,
  reconnectHandler,
);
