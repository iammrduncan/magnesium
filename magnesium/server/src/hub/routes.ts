import { HUB_MACHINES_PATH, HubMachineAccessInput } from "@magnesium/contracts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerPorts } from "../ports.ts";
import { HubMachines } from "./HubMachines.ts";

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

/** Runs `onAllowed` for a caller holding `scope`, or answers 401/403. */
const withScope = <E, R>(
  scope: AuthEnvironmentScope,
  onAllowed: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const ports = yield* ServerPorts;
    const caller = yield* ports.authenticate(request).pipe(Effect.option);
    if (Option.isNone(caller)) return jsonError(401, "Sign in to the hub first.");
    if (!caller.value.scopes.includes(scope)) {
      return jsonError(403, `This needs the ${scope} scope on the hub.`);
    }
    return yield* onAllowed;
  });

const machineName = HttpRouter.params.pipe(Effect.map((params) => params.name ?? ""));

const accessErrors = <A, R>(
  effect: Effect.Effect<
    A,
    | { readonly _tag: "HubMachineNotFoundError"; readonly name: string }
    | { readonly _tag: "HubMachineAccessError"; readonly detail: string }
    | { readonly _tag: "ServerPortError"; readonly detail: string },
    R
  >,
  onSuccess: (value: A) => HttpServerResponse.HttpServerResponse,
) =>
  effect.pipe(
    Effect.map(onSuccess),
    Effect.catchTags({
      HubMachineNotFoundError: (error) =>
        Effect.succeed(jsonError(404, `No machine ${error.name}.`)),
      HubMachineAccessError: (error) => Effect.succeed(jsonError(422, error.detail)),
      ServerPortError: (error) =>
        Effect.logError("Hub machine access failed.", { error }).pipe(
          Effect.as(jsonError(500, "The hub could not save that.")),
        ),
    }),
  );

/** The machines this hub carries. Every signed-in client polls it to list them. */
const listRoute = HttpRouter.add(
  "GET",
  HUB_MACHINES_PATH,
  withScope(
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const machines = yield* HubMachines;
      return yield* machines.list.pipe(
        Effect.map((list) => HttpServerResponse.jsonUnsafe(list)),
        Effect.catch((error) =>
          Effect.logError("Could not list the hub's machines.", { error }).pipe(
            Effect.as(jsonError(500, "Could not list the hub's machines.")),
          ),
        ),
      );
    }),
  ),
);

/** Give the hub access to a machine: a token moved off a browser, or a pairing code. */
const giveAccessRoute = HttpRouter.add(
  "PUT",
  `${HUB_MACHINES_PATH}/:name/access`,
  withScope(
    AuthAccessWriteScope,
    Effect.gen(function* () {
      const name = yield* machineName;
      const input = yield* HttpServerRequest.schemaBodyJson(HubMachineAccessInput).pipe(
        Effect.option,
      );
      if (Option.isNone(input)) return jsonError(400, "Send a bearerToken or a pairingCode.");
      const machines = yield* HubMachines;
      return yield* accessErrors(machines.giveAccess(name, input.value), (machine) =>
        HttpServerResponse.jsonUnsafe(machine),
      );
    }),
  ),
);

const removeAccessRoute = HttpRouter.add(
  "DELETE",
  `${HUB_MACHINES_PATH}/:name/access`,
  withScope(
    AuthAccessWriteScope,
    Effect.gen(function* () {
      const name = yield* machineName;
      const machines = yield* HubMachines;
      return yield* accessErrors(machines.removeAccess(name), () =>
        HttpServerResponse.empty({ status: 204 }),
      );
    }),
  ),
);

export const hubMachineRoutesLayer = Layer.mergeAll(listRoute, giveAccessRoute, removeAccessRoute);
