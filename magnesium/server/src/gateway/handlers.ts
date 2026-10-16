import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Spokes } from "./Spokes.ts";

const listHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.spokesList,
  Effect.gen(function* () {
    const spokes = yield* Spokes;
    return () => spokes.list;
  }),
);

const applyHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.spokesApply,
  Effect.gen(function* () {
    const spokes = yield* Spokes;
    return (input) => spokes.apply(input);
  }),
);

const removeHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.spokesRemove,
  Effect.gen(function* () {
    const spokes = yield* Spokes;
    return (input) => spokes.remove(input);
  }),
);

export const spokeHandlersLayer = Layer.mergeAll(listHandler, applyHandler, removeHandler);
