import { SESSION_END_PATH, SESSION_RENEW_PATH, SessionRenewResult } from "@magnesium/contracts";
import {
  AuthAccessReadScope,
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthEnvironmentBootstrapTokenType,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { urlUnder } from "../forward.ts";

/** How the hub talks to a machine server, at the machine's own origin (its URL, or a loopback relay to it). */

const REQUEST_TIMEOUT = Duration.seconds(5);

export class MachineRequestError extends Schema.TaggedError<MachineRequestError>()(
  "MachineRequestError",
  {
    detail: Schema.String,
    /** The machine refused the hub's token: give the hub access again. */
    rejected: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

const isRejection = (cause: unknown): boolean => {
  if (Predicate.isTagged(cause, "EnvironmentAuthInvalidError")) return true;
  if (Predicate.isTagged(cause, "EnvironmentTokenExchangeInvalidError")) return true;
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return cause.response.status === 401 || cause.response.status === 403;
  }
  return false;
};

const request = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new MachineRequestError({
          detail: `The machine did not answer the ${what} request.`,
          rejected: isRejection(cause),
          cause,
        }),
    ),
  );

const group = <Group extends keyof typeof EnvironmentHttpApi.groups>(
  baseUrl: string,
  name: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, { httpClient, group: name, baseUrl }),
  );

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const fetchDescriptor = (baseUrl: string) =>
  request(
    "descriptor",
    Effect.flatMap(group(baseUrl, "metadata"), (client) => client.descriptor()),
  );

/** The session behind a token. An unknown, expired or revoked token is unauthenticated, not an error. */
export const fetchSession = (baseUrl: string, token: string) =>
  request(
    "session",
    Effect.flatMap(group(baseUrl, "auth"), (client) => client.session({ headers: bearer(token) })),
  );

export const issueWebSocketTicket = (baseUrl: string, token: string) =>
  request(
    "WebSocket ticket",
    Effect.flatMap(group(baseUrl, "auth"), (client) =>
      client.webSocketTicket({ headers: bearer(token) }),
    ),
  );

/**
 * What the hub asks for when it pairs with a machine: a standard session's
 * scopes without managing access or the relay, which the hub never holds
 * (goal 04). Since upstream v0.1.1 a pairing link grants those by default,
 * and a machine issues only the requested scopes the link has.
 */
export const HUB_MACHINE_SCOPES = AuthStandardClientScopes.filter(
  (scope) =>
    scope !== AuthAccessReadScope &&
    scope !== AuthAccessWriteScope &&
    scope !== AuthRelayWriteScope,
);

/** Trade a pairing code minted on the machine for a bearer token the hub keeps. */
export const exchangePairingCode = (baseUrl: string, code: string) =>
  request(
    "pairing",
    Effect.flatMap(group(baseUrl, "auth"), (client) =>
      client.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: code,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: HUB_MACHINE_SCOPES.join(" "),
          client_label: "Magnesium hub",
          client_device_type: "bot",
        },
      }),
    ),
  );

/**
 * Swap the hub's token for a fresh one (`magnesium/server`'s renew route, on
 * the machine). None when the machine says the token is not due yet.
 */
export const renewSession = (baseUrl: string, token: string) =>
  request(
    "renewal",
    Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
      httpClient
        .execute(
          HttpClientRequest.post(urlUnder(baseUrl, SESSION_RENEW_PATH).toString()).pipe(
            HttpClientRequest.setHeaders(bearer(token)),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 409
              ? Effect.succeedNone
              : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionRenewResult)),
                  Effect.map(Option.some),
                ),
          ),
        ),
    ),
  );

/** Ends the hub's session on a machine, so its token stops working there (Forget, goal 35). */
export const endSession = (baseUrl: string, token: string) =>
  request(
    "sign-out",
    Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
      httpClient
        .execute(
          HttpClientRequest.delete(urlUnder(baseUrl, SESSION_END_PATH).toString()).pipe(
            HttpClientRequest.setHeaders(bearer(token)),
          ),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.asVoid),
    ),
  );
