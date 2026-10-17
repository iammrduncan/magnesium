import {
  type SpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { KubeApi } from "./kube.ts";
import {
  type RenderContext,
  renderWorkload,
  renderSecret,
  secretFingerprint,
  renderService,
  renderVolume,
  SPOKE_APP,
  spokeObjectNames,
  spokeStatusOf,
  type WorkloadView,
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
/** How long to wait for an old Deployment's pod to stop: up to a minute and a half. */
const LEGACY_POLL = Duration.seconds(3);
const LEGACY_TRIES = 30;

/** The parts of an event the gateway reads. */
interface EventView {
  readonly type?: string;
  readonly message?: string;
  readonly lastTimestamp?: string;
  readonly eventTime?: string;
}
const eventTime = (event: EventView) => event.lastTimestamp ?? event.eventTime ?? "";

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
      yield* retireLegacyDeployment(spec.name);
      const workload = yield* kube.apply(
        { group: APPS, resource: "statefulsets", name: names.workload },
        renderWorkload(spec, render, secretData === null ? null : secretFingerprint(secretData)),
      );
      return (
        spokeStatusOf(workload as WorkloadView) ?? {
          name: spec.name,
          node: spec.node,
          build: null,
          replicas: spec.replicas,
          ready: false,
          detail: "Starting.",
        }
      );
    });

    /**
     * A spoke made before StatefulSets ran as a Deployment. Remove it, and wait
     * for its pod to go, before the StatefulSet's pod opens the same database.
     */
    const retireLegacyDeployment = Effect.fn("Spokes.retireLegacyDeployment")(function* (
      name: string,
    ) {
      const legacy = {
        group: APPS,
        resource: "deployments",
        name: spokeObjectNames(name).legacyDeployment,
      };
      if ((yield* kube.get(legacy))._tag === "None") return;
      yield* kube.remove(legacy);
      const podsGone = kube
        .list({ group: CORE, resource: "pods" }, { labelSelector: `magnesium.machine=${name}` })
        .pipe(
          Effect.flatMap((pods) =>
            pods.length === 0
              ? Effect.void
              : Effect.fail(new SpokeError({ detail: `${name}'s old pod is still stopping.` })),
          ),
        );
      yield* podsGone.pipe(
        Effect.retry({ schedule: Schedule.spaced(LEGACY_POLL), times: LEGACY_TRIES }),
      );
    });

    /** The cluster's latest warning about a spoke's workload or its pod, such as a refusal. */
    const latestWarning = (name: string) => {
      const workload = spokeObjectNames(name).workload;
      return Effect.forEach([workload, `${workload}-0`], (involved) =>
        kube.list(
          { group: CORE, resource: "events" },
          { fieldSelector: `involvedObject.name=${involved}` },
        ),
      ).pipe(
        Effect.map((lists) => {
          const warnings = lists
            .flat()
            .map((event) => event as EventView)
            .filter((event) => event.type === "Warning" && typeof event.message === "string")
            .toSorted((left, right) => eventTime(right).localeCompare(eventTime(left)));
          return warnings[0]?.message ?? null;
        }),
        Effect.orElseSucceed(() => null),
      );
    };

    const list = Effect.gen(function* () {
      const selector = { labelSelector: `app.kubernetes.io/name=${SPOKE_APP}` };
      const [workloads, legacy] = yield* Effect.all([
        kube.list({ group: APPS, resource: "statefulsets" }, selector),
        kube.list({ group: APPS, resource: "deployments" }, selector),
      ]);
      const statuses = new Map<string, SpokeStatus>();
      // A spoke not yet moved to a StatefulSet still shows, from its Deployment.
      for (const item of [...legacy, ...workloads]) {
        const status = spokeStatusOf(item as WorkloadView);
        if (status !== null) statuses.set(status.name, status);
      }
      return yield* Effect.forEach(
        [...statuses.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
        (status) =>
          status.ready || status.replicas === 0 || status.detail !== "Starting."
            ? Effect.succeed(status)
            : latestWarning(status.name).pipe(
                Effect.map((warning) =>
                  warning === null ? status : { ...status, detail: warning },
                ),
              ),
      );
    });

    const remove = Effect.fn("Spokes.remove")(function* (input: SpokeRemoveInput) {
      const names = spokeObjectNames(input.name);
      yield* kube.remove({ group: APPS, resource: "statefulsets", name: names.workload });
      yield* kube.remove({ group: APPS, resource: "deployments", name: names.legacyDeployment });
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
