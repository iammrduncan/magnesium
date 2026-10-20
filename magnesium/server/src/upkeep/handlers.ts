import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Upkeep } from "./Upkeep.ts";

/** This server's upkeep, asked for by the hub or a client (goal 35). */
const backupsHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.upkeepBackups,
  Effect.gen(function* () {
    const upkeep = yield* Upkeep;
    return () => upkeep.backups;
  }),
);

const backupNowHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.upkeepBackupNow,
  Effect.gen(function* () {
    const upkeep = yield* Upkeep;
    return () => upkeep.backupNow;
  }),
);

const restoreHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.upkeepRestore,
  Effect.gen(function* () {
    const upkeep = yield* Upkeep;
    return (input) => upkeep.restore(input.name);
  }),
);

const rollbackHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.upkeepRollback,
  Effect.gen(function* () {
    const upkeep = yield* Upkeep;
    return () => upkeep.rollback;
  }),
);

const updateHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.upkeepUpdate,
  Effect.gen(function* () {
    const upkeep = yield* Upkeep;
    return (input) => upkeep.update(input);
  }),
);

export const upkeepHandlersLayer = Layer.mergeAll(
  backupsHandler,
  backupNowHandler,
  restoreHandler,
  rollbackHandler,
  updateHandler,
);
