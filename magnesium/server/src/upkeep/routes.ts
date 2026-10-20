import { ReleaseName, UPKEEP_RELEASES_PATH } from "@magnesium/contracts";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { NOT_PAIRED_DETAIL, ServerPorts } from "../ports.ts";
import { grantsScope } from "../session/scopes.ts";
import { Upkeep } from "./Upkeep.ts";

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

const isRelease = Schema.is(ReleaseName);

/**
 * Takes a build the hub sends (goal 35): the pack as the body, unpacked into
 * this machine's releases, ready for `upkeep.update`. Over HTTP rather than the
 * WebSocket, since a pack is hundreds of megabytes.
 */
export const upkeepReleaseRoute = HttpRouter.add(
  "PUT",
  `${UPKEEP_RELEASES_PATH}/:name`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ports = yield* ServerPorts;
    const caller = yield* ports.authenticate(request).pipe(Effect.option);
    if (Option.isNone(caller)) return jsonError(401, "Sign in first.");
    if (!caller.value.paired) return jsonError(403, NOT_PAIRED_DETAIL);
    if (!grantsScope(caller.value.scopes, AuthEnvironmentMaintainScope)) {
      return jsonError(403, `This needs the ${AuthEnvironmentMaintainScope} scope.`);
    }
    const name = (yield* HttpRouter.params).name ?? "";
    if (!isRelease(name)) return jsonError(400, `${name} isn't a release name.`);
    const upkeep = yield* Upkeep;
    return yield* upkeep.receiveRelease(name, request.stream).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204 })),
      Effect.catch((error) => Effect.succeed(jsonError(422, error.detail))),
    );
  }),
);
