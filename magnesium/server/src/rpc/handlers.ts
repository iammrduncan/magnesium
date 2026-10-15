import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerStatus } from "../status/ServerStatus.ts";

/**
 * Handlers for the core of `MagnesiumRpcGroup`. Each feature provides the
 * handlers for its own RPCs as a layer like this one, merged in `index.ts`;
 * scopes are checked by the route, from each RPC's `RequiredScope`.
 */

const pingHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.ping,
  Effect.gen(function* () {
    const status = yield* ServerStatus;
    return () =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          serverVersion: status.serverVersion,
          startedAt: status.startedAt,
          now: DateTime.formatIso(now),
        })),
      );
  }),
);

const serverStatusHandler = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.serverStatus,
  Effect.gen(function* () {
    const status = yield* ServerStatus;
    return (input) => status.subscribe(input);
  }),
);

export const coreHandlersLayer = Layer.mergeAll(pingHandler, serverStatusHandler);
