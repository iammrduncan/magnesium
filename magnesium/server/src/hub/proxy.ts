import { HUB_ENVIRONMENT_ROUTE_PREFIX } from "@magnesium/contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { NOT_PAIRED_DETAIL, ServerPorts } from "../ports.ts";
import { HubMachines } from "./HubMachines.ts";
import * as MachineApi from "./machineApi.ts";

/**
 * Serves each machine server at `/api/magnesium/env/<name>/…` on the hub's own
 * origin, the way `DeviceHubProxy` serves the device hub. The browser sends its
 * hub session (a same-origin cookie); the hub checks it, drops it, and sends the
 * machine the token only the hub holds. Under `/api` so every front door and
 * the dev proxy already carry it, WebSocket upgrades included.
 */

/** Paths a client of a machine needs; pairing and admin routes stay off the proxy. */
const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/\.well-known\/t3\/environment$/,
  /^\/ws$/,
  /^\/api\/auth\/(session|websocket-ticket)$/,
  /^\/api\/(?!auth\/|magnesium\/)[a-z0-9-]+(\/.*)?$/,
];

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  // The hub's credentials end here; the machine gets the hub's own token.
  "cookie",
  "authorization",
  "dpop",
  "origin",
  "referer",
  "content-length",
  "accept-encoding",
]);

/** A machine's cookies must never land on the hub's origin, next to the hub's session cookie. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const WEBSOCKET_TICKET_PARAM = "wsTicket";

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

/** `/api/magnesium/env/<name>/<rest>` into the machine name and the machine-side path. */
export const parseProxyPath = (
  pathname: string,
): { readonly name: string; readonly path: string } | null => {
  const prefix = `${HUB_ENVIRONMENT_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let name: string;
  try {
    name = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null;
  }
  const path = rest.slice(slash);
  return ALLOWED_PATHS.some((pattern) => pattern.test(path)) ? { name, path } : null;
};

const proxyWebSocket = Effect.fn("HubProxy.proxyWebSocket")(function* (
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

const proxyHttp = Effect.fn("HubProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  token: string,
) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  headers.authorization = `Bearer ${token}`;
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
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
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

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return jsonError(400, "Bad request.");
  const target = parseProxyPath(url.value.pathname);
  if (target === null) return jsonError(404, "Not found.");

  const ports = yield* ServerPorts;
  const caller = yield* ports.authenticate(request).pipe(Effect.option);
  if (Option.isNone(caller)) return jsonError(401, "Sign in to the hub first.");
  if (!caller.value.paired) return jsonError(403, NOT_PAIRED_DETAIL);
  const upgrade = isWebSocketUpgrade(request);
  const readOnly = !upgrade && (request.method === "GET" || request.method === "HEAD");
  const requiredScope = readOnly ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope;
  if (!caller.value.scopes.includes(requiredScope)) {
    return jsonError(403, `This needs the ${requiredScope} scope on the hub.`);
  }

  const machines = yield* HubMachines;
  const upstream = yield* machines.upstream(target.name).pipe(Effect.option);
  if (Option.isNone(upstream)) {
    return jsonError(503, `The hub has no access to ${target.name}.`);
  }
  const search = new URLSearchParams(url.value.search);

  if (upgrade) {
    // A ticket on the request was minted by the machine through this proxy;
    // otherwise mint one with the hub's token.
    if (!search.has(WEBSOCKET_TICKET_PARAM)) {
      const ticket = yield* MachineApi.issueWebSocketTicket(
        upstream.value.url,
        upstream.value.token,
      ).pipe(
        Effect.tapError((error) =>
          error.rejected ? machines.markRejected(target.name) : Effect.void,
        ),
        Effect.option,
      );
      if (Option.isNone(ticket)) {
        return jsonError(502, `${target.name} did not answer.`);
      }
      search.set(WEBSOCKET_TICKET_PARAM, ticket.value.ticket);
    }
    const wsUrl = new URL(`${target.path}?${search.toString()}`, upstream.value.url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    return yield* proxyWebSocket(request, wsUrl.toString());
  }

  const query = search.size > 0 ? `?${search.toString()}` : "";
  const httpUrl = new URL(`${target.path}${query}`, upstream.value.url).toString();
  const proxied = yield* proxyHttp(request, httpUrl, upstream.value.token).pipe(Effect.option);
  if (Option.isNone(proxied)) return jsonError(502, `${target.name} did not answer.`);
  if (proxied.value.status === 401) yield* machines.markRejected(target.name);
  return proxied.value.response;
});

export const hubProxyRouteLayer = HttpRouter.add("*", `${HUB_ENVIRONMENT_ROUTE_PREFIX}/*`, handler);
