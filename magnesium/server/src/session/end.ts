import { SESSION_END_PATH } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerPorts } from "../ports.ts";

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

/**
 * Ends the caller's own bearer session (goal 35). The hub's Forget calls it with
 * its token for the machine, so a forgotten machine no longer lets the hub in,
 * even if the hub's copy of the token were kept somewhere. Only through the
 * hub's own client: the hub's proxy never forwards `/api/magnesium/…`.
 */
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ports = yield* ServerPorts;
  const caller = yield* ports.authenticate(request).pipe(Effect.option);
  if (Option.isNone(caller)) return jsonError(401, "Not signed in.");
  if (caller.value.method !== "bearer-access-token") {
    return jsonError(403, "Only a bearer session ends itself here.");
  }
  if (ports.endSession === undefined) return jsonError(501, "This server can't end sessions.");
  return yield* ports.endSession(caller.value.sessionId).pipe(
    Effect.as(HttpServerResponse.empty({ status: 204 })),
    Effect.catch((error) =>
      Effect.logError("Could not end a session.", { error }).pipe(
        Effect.as(jsonError(500, "Could not end the session.")),
      ),
    ),
  );
});

export const sessionEndRouteLayer = HttpRouter.add("DELETE", SESSION_END_PATH, handler);
