import {
  type SpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { KubeApi } from "./kube.ts";
import {
  type DeploymentView,
  type RenderContext,
  renderDeployment,
  renderSecret,
  secretFingerprint,
  renderService,
  renderVolume,
  SPOKE_APP,
  spokeObjectNames,
  spokeStatusOf,
} from "./manifests.ts";

/**
 * A gateway's spokes (goal 25): the hub asks, the gateway applies them to its
 * namespace with the namespace's identity. Everything else is the cluster's:
 * a spec outside the operator's envelope is refused there, and the refusal comes
 * back in the spoke's status or as the error.
 */
export class Spokes extends Context.Service<
  Spokes,
  {
    readonly list: Effect.Effect<ReadonlyArray<SpokeStatus>, SpokeError>;
    readonly apply: (input: SpokeApplyInput) => Effect.Effect<SpokeStatus, SpokeError>;
    readonly remove: (input: SpokeRemoveInput) => Effect.Effect<void, SpokeError>;
  }
>()("@magnesium/server/gateway/Spokes") {}

const CORE = "/api/v1";
const APPS = "/apis/apps/v1";

export const make = (context: Omit<RenderContext, "namespace">) =>
  Effect.gen(function* () {
    const kube = yield* KubeApi;
    const render: RenderContext = { ...context, namespace: kube.namespace };

    const apply = Effect.fn("Spokes.apply")(function* (input: SpokeApplyInput) {
      const { spec, secrets } = input;
      const names = spokeObjectNames(spec.name);
      // The Secret as it will be: the one sent, or the one already there.
      const secretData: Readonly<Record<string, string>> | null =
        secrets !== null
          ? renderSecret(spec, secrets, render).data
          : yield* kube
              .get({ group: CORE, resource: "secrets", name: names.secret })
              .pipe(
                Effect.map((found) =>
                  found._tag === "Some" &&
                  typeof found.value === "object" &&
                  found.value !== null &&
                  "data" in found.value &&
                  typeof found.value.data === "object" &&
                  found.value.data !== null
                    ? (found.value.data as Record<string, string>)
                    : null,
                ),
              );
      yield* kube.apply(
        { group: CORE, resource: "persistentvolumeclaims", name: names.volume },
        renderVolume(spec, render),
      );
      if (secrets !== null) {
        yield* kube.apply(
          { group: CORE, resource: "secrets", name: names.secret },
          renderSecret(spec, secrets, render),
        );
      }
      yield* kube.apply(
        { group: CORE, resource: "services", name: names.service },
        renderService(spec, render),
      );
      const deployment = yield* kube.apply(
        { group: APPS, resource: "deployments", name: names.deployment },
        renderDeployment(spec, render, secretData === null ? null : secretFingerprint(secretData)),
      );
      return (
        spokeStatusOf(deployment as DeploymentView) ?? {
          name: spec.name,
          node: spec.node,
          build: null,
          replicas: spec.replicas,
          ready: false,
          detail: "Starting.",
        }
      );
    });

    const list = kube
      .list({ group: APPS, resource: "deployments" }, `app.kubernetes.io/name=${SPOKE_APP}`)
      .pipe(
        Effect.map((items) =>
          items
            .map((item) => spokeStatusOf(item as DeploymentView))
            .filter((status) => status !== null)
            .toSorted((left, right) => left.name.localeCompare(right.name)),
        ),
      );

    const remove = Effect.fn("Spokes.remove")(function* (input: SpokeRemoveInput) {
      const names = spokeObjectNames(input.name);
      yield* kube.remove({ group: APPS, resource: "deployments", name: names.deployment });
      yield* kube.remove({ group: CORE, resource: "services", name: names.service });
      yield* kube.remove({ group: CORE, resource: "secrets", name: names.secret });
      if (!input.keepVolume) {
        yield* kube.remove({ group: CORE, resource: "persistentvolumeclaims", name: names.volume });
      }
    });

    return Spokes.of({ list, apply, remove });
  });

/** Every server answers the spoke RPCs; only a gateway can do anything. */
export const notAGatewayLayer = Layer.succeed(
  Spokes,
  Spokes.of({
    list: Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    apply: () => Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    remove: () => Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
  }),
);
