import { SESSION_RENEW_PATH } from "@magnesium/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerPorts } from "../ports.ts";

/**
 * Upstream bearer sessions last 30 days and have no refresh. The hub keeps one
 * per machine, so each machine server lets a bearer session in its last week
 * trade itself for a new one with the same scopes. The old session runs out on
 * its own, so live connections on it are not cut.
 */

const RENEWABLE_WITHIN = Duration.days(8);

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ports = yield* ServerPorts;
  const caller = yield* ports.authenticate(request).pipe(Effect.option);
  if (Option.isNone(caller)) return jsonError(401, "Not signed in.");
  if (caller.value.method !== "bearer-access-token" || caller.value.expiresAt === undefined) {
    return jsonError(403, "Only bearer sessions can be renewed.");
  }
  const now = yield* DateTime.now;
  if (DateTime.isGreaterThan(caller.value.expiresAt, DateTime.addDuration(now, RENEWABLE_WITHIN))) {
    return jsonError(409, "This session is not due for renewal yet.");
  }
  const issued = yield* ports
    .issueBearerSession({
      subject: caller.value.subject,
      scopes: caller.value.scopes,
      label: "Magnesium hub",
    })
    .pipe(Effect.option);
  if (Option.isNone(issued)) return jsonError(500, "Could not issue a new session.");
  return HttpServerResponse.jsonUnsafe({
    token: issued.value.token,
    expiresAt: DateTime.formatIso(issued.value.expiresAt),
  });
});

export const sessionRenewRouteLayer = HttpRouter.add("POST", SESSION_RENEW_PATH, handler);
