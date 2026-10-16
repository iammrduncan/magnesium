import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Passing a request on to another server, for the hub's proxy to its machines
 * and the gateway's to its spokes. Each caller decides which headers go on.
 */

/** Headers that belong to one hop, never forwarded. */
export const HOP_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "content-length",
  "accept-encoding",
]);

/** The client decodes bodies, so their encoding and length no longer hold. */
export const HOP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/** A request's headers without `dropped`, ready to send on. */
export const forwardedHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  dropped: ReadonlySet<string>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (dropped.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
};

/** Sends `request` on to `upstreamUrl` with `headers`, streaming both bodies. */
export const forwardHttp = Effect.fn("forwardHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  headers: Record<string, string>,
  droppedResponseHeaders: ReadonlySet<string>,
) {
  const method = request.method;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* httpClient.execute(
    HttpClientRequest.make(method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders(headers),
      method === "GET" || method === "HEAD"
        ? (self) => self
        : HttpClientRequest.bodyStream(request.stream),
    ),
  );
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (droppedResponseHeaders.has(name) || value === undefined) continue;
    responseHeaders[name] = value;
  }
  return {
    status: response.status,
    response: HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers: responseHeaders,
      ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
    }),
  };
});

/** Upgrades `request` and joins it to a WebSocket at `upstreamUrl`, frame for frame. */
export const forwardWebSocket = Effect.fn("forwardWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      // Frames pass through untouched, text as text. Whichever side closes first
      // ends the other through scope teardown.
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

/**
 * `path` (with its query) under `base`, keeping any path `base` has: a spoke
 * behind a gateway is `https://gateway.example/spokes/cpu-host-2`, and
 * `new URL("/ws", base)` would drop the `/spokes/cpu-host-2`.
 */
export const urlUnder = (base: string, path: string): URL => {
  const url = new URL(base);
  const target = new URL(path, "http://placeholder");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${target.pathname}`;
  url.search = target.search;
  return url;
};
