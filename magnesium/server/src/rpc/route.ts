import {
  MAGNESIUM_WS_PATH,
  MagnesiumRpcGroup,
  type MagnesiumRpcs,
  RequiredScope,
  ScopeGuard,
} from "@magnesium/contracts";
import { type AuthEnvironmentScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import { NOT_PAIRED_DETAIL, ServerPorts } from "../ports.ts";

/**
 * Serves `MagnesiumRpcGroup` at `MAGNESIUM_WS_PATH`, the way upstream serves
 * `/ws`: the upgrade is authenticated by upstream's auth (a `wsTicket`, the
 * session cookie or a bearer token), and each call is checked against the
 * scope its RPC names. Handlers are built once, at server start; each
 * connection gets its own protocol and scope guard.
 */

/** Refuses a call whose RPC needs a scope the caller lacks, and any RPC that names none. */
export const scopeGuard = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  ScopeGuard.of((effect, { rpc }) => {
    const required = Context.getOption(rpc.annotations, RequiredScope);
    if (Option.isNone(required)) {
      return Effect.die(new Error(`${rpc._tag} names no RequiredScope.`));
    }
    return scopes.includes(required.value)
      ? effect
      : Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${required.value}.`,
            requiredScope: required.value,
          }),
        );
  });

const jsonError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status });

export const magnesiumWsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const handlers = Layer.succeedContext(yield* Effect.context<Rpc.ToHandler<MagnesiumRpcs>>());
    return HttpRouter.add(
      "GET",
      MAGNESIUM_WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const caller = yield* ports.authenticateWebSocket(request).pipe(
          Effect.tapErrorTag("ServerPortError", (error) =>
            Effect.logError("Could not authenticate a Magnesium socket.", { error }),
          ),
          Effect.option,
        );
        if (Option.isNone(caller)) return jsonError(401, "Sign in first.");
        // The hub's machine tokens stand behind this route: paired devices only.
        if (!caller.value.paired) return jsonError(403, NOT_PAIRED_DETAIL);
        const httpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(MagnesiumRpcGroup, { disableTracing: true }).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.forkScoped,
          );
          // @effect-diagnostics-next-line returnEffectInGen:off
          return httpEffect;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              handlers,
              Layer.succeed(ScopeGuard, scopeGuard(caller.value.scopes)),
              RpcSerialization.layerJson,
            ),
          ),
        );
        return yield* httpEffect;
      }),
    );
  }),
);
