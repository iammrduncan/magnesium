import { HubMachineName } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

/**
 * The gateway role (goal 25, D57): one Magnesium server per Kubernetes
 * namespace, the namespace's one published entry point. The hub reaches each
 * spoke at `<gateway>/spokes/<name>`, and the gateway passes the request on to
 * that spoke's Service, HTTP and WebSocket alike. It adds and removes nothing:
 * the hub's own token for each spoke passes through, and the spoke checks it
 * as it would at its own address. Only the hub can reach the gateway.
 */

export const GATEWAY_ROUTE_PREFIX = "/spokes";

/** Where a spoke's server answers inside the namespace: its Service, by default. */
export const DEFAULT_SPOKE_URL = "http://magnesium-{name}:3773";

export interface GatewayConfig {
  /** The origin of the spoke named `name`. */
  readonly spokeOrigin: (name: string) => string;
}

/**
 * The gateway's config from its environment, or null when this server is not
 * a gateway: `MAGNESIUM_ROLE=gateway`, and `MAGNESIUM_SPOKE_URL` as a template
 * with `{name}` (default `http://magnesium-{name}:3773`).
 */
export const gatewayConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): GatewayConfig | null => {
  if (env.MAGNESIUM_ROLE?.trim() !== "gateway") return null;
  const template = env.MAGNESIUM_SPOKE_URL?.trim() || DEFAULT_SPOKE_URL;
  return { spokeOrigin: (name) => template.replaceAll("{name}", name) };
};

const isSpokeName = Schema.is(HubMachineName);

/** `/spokes/<name>/<rest>` into the spoke's name and its own path; null for anything else. */
export const parseSpokePath = (
  pathname: string,
): { readonly name: string; readonly path: string } | null => {
  const prefix = `${GATEWAY_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  // Names are plain: no escapes, so no way to aim at another host.
  if (!isSpokeName(name)) return null;
  return { name, path: slash === -1 ? "/" : rest.slice(slash) };
};

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

const handler = (config: GatewayConfig) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return jsonError(400, "Bad request.");
    const target = parseSpokePath(url.value.pathname);
    if (target === null) return jsonError(404, "Not found.");
    const upstream = urlUnder(config.spokeOrigin(target.name), `${target.path}${url.value.search}`);

    if (isWebSocketUpgrade(request)) {
      upstream.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
      return yield* forwardWebSocket(request, upstream.toString()).pipe(
        Effect.orElseSucceed(() => jsonError(502, `${target.name} did not answer.`)),
      );
    }
    const forwarded = yield* forwardHttp(
      request,
      upstream.toString(),
      forwardedHeaders(request, HOP_HEADERS),
      HOP_RESPONSE_HEADERS,
    ).pipe(Effect.option);
    if (Option.isNone(forwarded)) return jsonError(502, `${target.name} did not answer.`);
    return forwarded.value.response;
  });

/** The gateway's route: `<prefix>/*` to each spoke. */
export const gatewayRouteLayer = (config: GatewayConfig) =>
  HttpRouter.add("*", `${GATEWAY_ROUTE_PREFIX}/*`, handler(config));
