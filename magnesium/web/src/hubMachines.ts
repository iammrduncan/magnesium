import {
  HUB_ENVIRONMENT_ROUTE_PREFIX,
  HUB_MACHINES_PATH,
  HubMachine,
  type HubMachineAccessInput,
  HubMachineList,
  hubEnvironmentBasePath,
  hubMachineAccessPath,
} from "@magnesium/contracts";
import { HubConnectionRegistration, HubConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * The machines the hub carries (doc 11, "The front door"). Every client signed
 * in to the hub lists them from the hub and reaches them through it, so pairing
 * a device with the hub brings every environment. Requests are same-origin with
 * the hub, so the browser's hub session cookie goes along.
 */

export class HubRequestError extends Schema.TaggedError<HubRequestError>()("HubRequestError", {
  status: Schema.NullOr(Schema.Number),
  message: Schema.String,
}) {}

const ErrorBody = Schema.Struct({ error: Schema.String });

const failure = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(
    Effect.map((body) => body.error),
    Effect.orElseSucceed(() => `The hub answered ${response.status}.`),
    Effect.flatMap((message) =>
      Effect.fail(new HubRequestError({ status: response.status, message })),
    ),
  );

const send = <A, I>(
  request: HttpClientRequest.HttpClientRequest,
  success: Schema.Codec<A, I> | null,
) =>
  Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request)).pipe(
    Effect.mapError(
      (cause) =>
        new HubRequestError({ status: null, message: `Could not reach the hub: ${cause.message}` }),
    ),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? success === null
          ? Effect.succeed(undefined as A)
          : HttpClientResponse.schemaBodyJson(success)(response).pipe(
              Effect.mapError(
                () =>
                  new HubRequestError({
                    status: response.status,
                    message: "The hub sent an unreadable answer.",
                  }),
              ),
            )
        : failure(response),
    ),
  );

const hubUrl = (hubHttpBaseUrl: string, path: string) => new URL(path, hubHttpBaseUrl).toString();

/** The hub's machines; an empty list from a server that is not a hub. */
export const fetchHubMachines = (hubHttpBaseUrl: string) =>
  send(HttpClientRequest.get(hubUrl(hubHttpBaseUrl, HUB_MACHINES_PATH)), HubMachineList).pipe(
    Effect.map((list) => list.machines),
  );

/** Needs `access:write` on the hub. */
export const giveHubAccess = (hubHttpBaseUrl: string, name: string, input: HubMachineAccessInput) =>
  send(
    HttpClientRequest.put(hubUrl(hubHttpBaseUrl, hubMachineAccessPath(name))).pipe(
      HttpClientRequest.bodyJsonUnsafe(input),
    ),
    HubMachine,
  );

/** Needs `access:write` on the hub. */
export const removeHubAccess = (hubHttpBaseUrl: string, name: string) =>
  send(HttpClientRequest.delete(hubUrl(hubHttpBaseUrl, hubMachineAccessPath(name))), null);

/** For UI handlers: run a hub request with the browser's fetch. */
export const runHubRequest = <A>(
  effect: Effect.Effect<A, HubRequestError, HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)));

/** Environments to register for the machines the hub can reach. */
export function hubConnectionRegistrations(
  hubHttpBaseUrl: string,
  machines: ReadonlyArray<HubMachine>,
): ReadonlyArray<HubConnectionRegistration> {
  return machines.flatMap((machine) => {
    if (machine.access !== "ready" || machine.environmentId === null) return [];
    const httpBaseUrl = new URL(hubEnvironmentBasePath(machine.name), hubHttpBaseUrl);
    const wsBaseUrl = new URL(httpBaseUrl);
    wsBaseUrl.protocol = httpBaseUrl.protocol === "https:" ? "wss:" : "ws:";
    return [
      new HubConnectionRegistration({
        target: new HubConnectionTarget({
          environmentId: machine.environmentId,
          label: machine.label,
          httpBaseUrl: httpBaseUrl.toString(),
          wsBaseUrl: wsBaseUrl.toString(),
        }),
      }),
    ];
  });
}

/** The hub machine a hub environment reaches, from its base URL. */
export function hubMachineNameOf(target: { readonly httpBaseUrl: string }): string | null {
  const prefix = `${HUB_ENVIRONMENT_ROUTE_PREFIX}/`;
  const { pathname } = new URL(target.httpBaseUrl);
  if (!pathname.startsWith(prefix)) return null;
  const name = pathname.slice(prefix.length).replace(/\/+$/, "");
  return name.length > 0 && !name.includes("/") ? decodeURIComponent(name) : null;
}

/**
 * Machines whose access this browser can move to the hub: the hub cannot reach
 * them, and the browser holds a token for the same environment from pairing it
 * directly (goal 02). Once the hub has the token, the hub's environment replaces
 * the saved one, and the token leaves the browser with it.
 */
export function machinesToMove(
  machines: ReadonlyArray<HubMachine>,
  savedTokens: ReadonlyMap<EnvironmentId, string>,
): ReadonlyArray<{ readonly name: string; readonly bearerToken: string }> {
  return machines.flatMap((machine) => {
    if (machine.access === "ready" || machine.environmentId === null) return [];
    const bearerToken = savedTokens.get(machine.environmentId);
    return bearerToken === undefined ? [] : [{ name: machine.name, bearerToken }];
  });
}
