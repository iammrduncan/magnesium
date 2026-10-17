import { MagnesiumRpcGroup } from "@magnesium/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

/** How one Magnesium server calls another's `MagnesiumRpcGroup`: the hub, each machine. */

export const makeMagnesiumRpcClient = RpcClient.make(MagnesiumRpcGroup);
export type MagnesiumRpcClient =
  typeof makeMagnesiumRpcClient extends Effect.Effect<infer Client, infer _E, infer _R>
    ? Client
    : never;

const SOCKET_OPEN_TIMEOUT = "10 seconds";

/**
 * Opens the route at `url` (with its `wsTicket`) for the life of the scope.
 * It never redials: once the socket closes every call fails, and the caller
 * decides when to try again, with a fresh ticket.
 */
export const connect = (url: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Socket.layerWebSocket(url, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
            Layer.provide(NodeSocket.layerWebSocketConstructor),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* makeMagnesiumRpcClient.pipe(Effect.provide(protocol));
  });
