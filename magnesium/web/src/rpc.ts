import { MAGNESIUM_WS_PATH, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

/**
 * The browser's connection to the hub's own `MagnesiumRpcGroup`. The page is
 * served by the hub, so the route is same-origin and the hub's session cookie
 * goes along; the browser never talks to a machine's route (D38).
 */

export const makeMagnesiumRpcClient = RpcClient.make(MagnesiumRpcGroup);
export type MagnesiumRpcClient =
  typeof makeMagnesiumRpcClient extends Effect.Effect<infer Client, infer _E, infer _R>
    ? Client
    : never;

/** `/api/magnesium/ws` on the page's own origin. */
export const magnesiumSocketUrl = (pageUrl: string): string => {
  const url = new URL(MAGNESIUM_WS_PATH, pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/**
 * Opens the route for the life of the scope. It never redials on its own:
 * once the socket closes every call fails, and the caller reconnects.
 */
export const connectMagnesium = (url: string) =>
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
          Socket.layerWebSocket(url, { openTimeout: "10 seconds" }).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* makeMagnesiumRpcClient.pipe(Effect.provide(protocol));
  });
