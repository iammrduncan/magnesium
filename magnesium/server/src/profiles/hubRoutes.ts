import { HUB_MACHINES_PATH, MAGNESIUM_WS_METHODS } from "@magnesium/contracts";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { connectMachine } from "../hub/machineRpc.ts";
import { NOT_PAIRED_DETAIL, ServerPorts } from "../ports.ts";

/**
 * The sandbox levels a machine the hub carries can run, for the sandbox chip
 * and Settings. Browsers only talk to the hub (D38), and the hub's proxy never
 * forwards Magnesium's own routes, so the hub asks the machine over its RPC
 * link. The hub's own levels are at the agents API's `/sandboxes`.
 */

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

export const machineSandboxesRoute = HttpRouter.add(
  "GET",
  `${HUB_MACHINES_PATH}/:name/sandboxes`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ports = yield* ServerPorts;
    const caller = yield* ports.authenticate(request).pipe(Effect.option);
    if (Option.isNone(caller)) return jsonError(401, "Sign in to the hub first.");
    if (!caller.value.paired) return jsonError(403, NOT_PAIRED_DETAIL);
    if (!caller.value.scopes.includes(AuthOrchestrationReadScope)) {
      return jsonError(403, `This needs the ${AuthOrchestrationReadScope} scope on the hub.`);
    }
    const name = (yield* HttpRouter.params).name ?? "";
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connectMachine(name);
        return yield* client[MAGNESIUM_WS_METHODS.listSandboxes]({});
      }),
    ).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.map((list) => HttpServerResponse.jsonUnsafe(list)),
      Effect.catch((error) =>
        Effect.succeed(jsonError(502, `Could not reach ${name}: ${String(error)}`)),
      ),
    );
  }),
);
