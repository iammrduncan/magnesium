import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Fleet } from "./Fleet.ts";
import { FleetUpkeep } from "./FleetUpkeep.ts";

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

// Each server's upkeep, asked of the hub (goal 35).
const backupsHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetBackups,
  Effect.gen(function* () {
    const upkeep = yield* FleetUpkeep;
    return (input) => upkeep.backups(input.machine);
  }),
);

const backupNowHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetBackupNow,
  Effect.gen(function* () {
    const upkeep = yield* FleetUpkeep;
    return (input) => upkeep.backupNow(input.machine);
  }),
);

const restoreHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetRestore,
  Effect.gen(function* () {
    const upkeep = yield* FleetUpkeep;
    return (input) => upkeep.restore(input.machine, input.name);
  }),
);

const rollbackHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetRollback,
  Effect.gen(function* () {
    const upkeep = yield* FleetUpkeep;
    return (input) => upkeep.rollback(input.machine);
  }),
);

const updateHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.fleetUpdate,
  Effect.gen(function* () {
    const upkeep = yield* FleetUpkeep;
    return (input) => upkeep.update(input.machine);
  }),
);

export const fleetHandlersLayer = Layer.mergeAll(
  machinesHandler,
  eventsHandler,
  eventHistoryHandler,
  reconnectHandler,
  backupsHandler,
  backupNowHandler,
  restoreHandler,
  rollbackHandler,
  updateHandler,
);
