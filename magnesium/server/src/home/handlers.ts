import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Home } from "./Home.ts";
import { LocalHome } from "./LocalHome.ts";

/** Handlers for Home's RPCs (goal 06); scopes are checked by the route. */

const needsLocalHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.needsLocal,
  Effect.gen(function* () {
    const local = yield* LocalHome;
    return (input) => local.subscribe(input);
  }),
);

const needsAnswerHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.needsAnswer,
  Effect.gen(function* () {
    const local = yield* LocalHome;
    return (input) => local.answer(input);
  }),
);

const needsDetailHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.needsDetail,
  Effect.gen(function* () {
    const local = yield* LocalHome;
    return (input) => local.detail(input.threadId);
  }),
);

const homeNeedsHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.homeNeeds,
  Effect.gen(function* () {
    const home = yield* Home;
    return (input) => home.subscribeNeeds(input);
  }),
);

const homeSummaryHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.homeSummary,
  Effect.gen(function* () {
    const home = yield* Home;
    return (input) => home.subscribeSummary(input);
  }),
);

const homeAnswerHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.homeAnswer,
  Effect.gen(function* () {
    const home = yield* Home;
    return (input) => home.answer(input);
  }),
);

const homePinHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.homePin,
  Effect.gen(function* () {
    const home = yield* Home;
    return (input) => home.pin(input);
  }),
);

const homeDetailHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.homeDetail,
  Effect.gen(function* () {
    const home = yield* Home;
    return (input) => home.detail(input.key);
  }),
);

export const homeHandlersLayer = Layer.mergeAll(
  needsLocalHandler,
  needsAnswerHandler,
  needsDetailHandler,
  homeNeedsHandler,
  homeSummaryHandler,
  homeAnswerHandler,
  homePinHandler,
  homeDetailHandler,
);
