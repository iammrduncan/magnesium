import { HUB_ENVIRONMENT_ROUTE_PREFIX } from "@magnesium/contracts";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  forwardedHeaders,
  forwardHttp,
  forwardWebSocket,
  HOP_HEADERS,
  HOP_RESPONSE_HEADERS,
  isWebSocketUpgrade,
  urlUnder,
} from "../forward.ts";
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

const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_HEADERS,
  // The hub's credentials end here; the machine gets the hub's own token.
  "cookie",
  "authorization",
  "dpop",
  "origin",
  "referer",
]);

/** A machine's cookies must never land on the hub's origin, next to the hub's session cookie. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_RESPONSE_HEADERS,
  "set-cookie",
]);

const WEBSOCKET_TICKET_PARAM = "wsTicket";

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
    const wsUrl = urlUnder(upstream.value.url, `${target.path}?${search.toString()}`);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    return yield* forwardWebSocket(request, wsUrl.toString());
  }

  const query = search.size > 0 ? `?${search.toString()}` : "";
  const httpUrl = urlUnder(upstream.value.url, `${target.path}${query}`).toString();
  const headers = forwardedHeaders(request, DROPPED_REQUEST_HEADERS);
  headers.authorization = `Bearer ${upstream.value.token}`;
  const proxied = yield* forwardHttp(request, httpUrl, headers, DROPPED_RESPONSE_HEADERS).pipe(
    Effect.option,
  );
  if (Option.isNone(proxied)) return jsonError(502, `${target.name} did not answer.`);
  if (proxied.value.status === 401) yield* machines.markRejected(target.name);
  return proxied.value.response;
});

export const hubProxyRouteLayer = HttpRouter.add("*", `${HUB_ENVIRONMENT_ROUTE_PREFIX}/*`, handler);
