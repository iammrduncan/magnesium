import {
  type GatewayAttached,
  MAGNESIUM_WS_METHODS,
  type SpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { HubMachines } from "./HubMachines.ts";
import { connectMachine } from "./machineRpc.ts";

/** The hub asking a gateway, one of its machines, about its spokes (goal 25). */
export class GatewayClient extends Context.Service<
  GatewayClient,
  {
    readonly list: (gateway: string) => Effect.Effect<ReadonlyArray<SpokeStatus>, SpokeError>;
    readonly apply: (
      gateway: string,
      input: SpokeApplyInput,
    ) => Effect.Effect<SpokeStatus, SpokeError>;
    readonly remove: (gateway: string, input: SpokeRemoveInput) => Effect.Effect<void, SpokeError>;
    readonly attached: (
      gateway: string,
    ) => Effect.Effect<ReadonlyArray<GatewayAttached>, SpokeError>;
    readonly attachedPaired: (gateway: string, name: string) => Effect.Effect<void, SpokeError>;
  }
>()("@magnesium/server/hub/gatewayClient") {}

const isSpokeError = Schema.is(SpokeError);

/** The gateway's own refusal passes through; anything else is about reaching it. */
const asSpokeError = (gateway: string) => (error: unknown) =>
  isSpokeError(error)
    ? error
    : new SpokeError({ detail: `Could not reach the gateway ${gateway}.` });

export const layer = Layer.effect(
  GatewayClient,
  Effect.gen(function* () {
    const machines = yield* HubMachines;
    const httpClient = yield* HttpClient.HttpClient;
    const call = <A, E>(
      gateway: string,
      use: (rpc: Effect.Success<ReturnType<typeof connectMachine>>) => Effect.Effect<A, E>,
    ) =>
      connectMachine(gateway).pipe(
        Effect.flatMap(use),
        Effect.scoped,
        Effect.provideService(HubMachines, machines),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.mapError(asSpokeError(gateway)),
      );
    return GatewayClient.of({
      list: (gateway) => call(gateway, (rpc) => rpc[MAGNESIUM_WS_METHODS.spokesList]()),
      apply: (gateway, input) =>
        call(gateway, (rpc) => rpc[MAGNESIUM_WS_METHODS.spokesApply](input)),
      remove: (gateway, input) =>
        call(gateway, (rpc) => rpc[MAGNESIUM_WS_METHODS.spokesRemove](input)),
      attached: (gateway) => call(gateway, (rpc) => rpc[MAGNESIUM_WS_METHODS.spokesAttached]()),
      attachedPaired: (gateway, name) =>
        call(gateway, (rpc) => rpc[MAGNESIUM_WS_METHODS.spokesAttachedPaired]({ name })),
    });
  }),
);
