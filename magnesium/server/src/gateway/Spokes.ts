import {
  type GatewayAttached,
  HubMachineName,
  type SpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

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
    /** Machines attached inside workloads' pods that this gateway routes to (D59). */
    readonly attached: Effect.Effect<ReadonlyArray<GatewayAttached>, SpokeError>;
    /** The hub has paired with one: mark its route, then drop its spent code. */
    readonly attachedPaired: (name: string) => Effect.Effect<void, SpokeError>;
  }
>()("@magnesium/server/gateway/Spokes") {}

/**
 * How an operator's deploy marks a route to an attached machine, in the
 * gateway's namespace: an ExternalName `magnesium-<machine>` labelled with the
 * machine's name (and its workload's), plus, for a new machine, a Secret
 * `magnesium-<machine>-pairing` holding its one-time code. Once the hub has
 * paired, the route carries ATTACHED_PAIRED and the Secret is gone, so a
 * redeploy knows not to write a spent code again.
 */
export const ATTACHED_LABEL = "magnesium.dev/attached";
export const ATTACHED_WORKLOAD_LABEL = "magnesium.dev/workload";
export const ATTACHED_PAIRED_LABEL = "magnesium.dev/paired";
export const PAIRING_CODE_KEY = "MAGNESIUM_HUB_PAIRING_CODE";
const pairingSecretName = (machine: string) => `magnesium-${machine}-pairing`;
const isMachineName = Schema.is(HubMachineName);

/** The parts of a route Service the gateway reads. */
interface RouteView {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
}

const CORE = "/api/v1";
const APPS = "/apis/apps/v1";
/** How long to wait for an old Deployment's pod to stop: up to a minute and a half. */
const LEGACY_POLL = Duration.seconds(3);
const LEGACY_TRIES = 30;

/** How long to wait for a StatefulSet's controller to see a new template: up to 15 seconds. */
const OBSERVE_POLL = Duration.seconds(1);
const OBSERVE_TRIES = 15;
const REVISION_LABEL = "controller-revision-hash";

/** The parts of a spoke's pod the gateway reads. */
interface PodView {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
  };
}
const isReady = (pod: PodView) =>
  pod.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ) ?? false;

/** The parts of a StatefulSet that say which template its controller has seen. */
interface RevisionView {
  readonly metadata?: { readonly generation?: number };
  readonly status?: { readonly observedGeneration?: number; readonly updateRevision?: string };
}

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

    const applyNow = Effect.fn("Spokes.apply")(function* (input: SpokeApplyInput) {
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
      yield* replaceStuckPods(spec.name).pipe(Effect.ignore);
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

    // A change runs to the end even when the hub stops waiting for it (it
    // restarted, say). Stopping between retiring a spoke's old Deployment and
    // applying its StatefulSet would leave the machine with nothing running.
    const apply = (input: SpokeApplyInput) => applyNow(input).pipe(Effect.uninterruptible);

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

    /**
     * A StatefulSet replaces its pod only once that pod is Ready, so a pod
     * stuck on a template that is gone (an image that never arrived, say)
     * would outlast the change that undoes it. Deletes such a pod, once the
     * controller has seen the new template, so it starts one from that.
     * Best effort: without the right to delete pods, the pod waits for a person.
     */
    const replaceStuckPods = Effect.fn("Spokes.replaceStuckPods")(function* (name: string) {
      const pods = (yield* kube.list(
        { group: CORE, resource: "pods" },
        { labelSelector: `magnesium.machine=${name}` },
      )) as ReadonlyArray<PodView>;
      const stuck = pods.filter((pod) => !isReady(pod));
      if (stuck.length === 0) return;
      const path = { group: APPS, resource: "statefulsets", name: spokeObjectNames(name).workload };
      const revision = yield* kube.get(path).pipe(
        Effect.flatMap((found) => {
          const view = found._tag === "Some" ? (found.value as RevisionView) : {};
          const seen =
            view.metadata?.generation !== undefined &&
            (view.status?.observedGeneration ?? 0) >= view.metadata.generation;
          return seen && view.status?.updateRevision !== undefined
            ? Effect.succeed(view.status.updateRevision)
            : Effect.fail(new SpokeError({ detail: `${name}'s new template isn't seen yet.` }));
        }),
        Effect.retry({ schedule: Schedule.spaced(OBSERVE_POLL), times: OBSERVE_TRIES }),
      );
      for (const pod of stuck) {
        const podName = pod.metadata?.name;
        const podRevision = pod.metadata?.labels?.[REVISION_LABEL];
        if (podName !== undefined && podRevision !== undefined && podRevision !== revision) {
          yield* kube.remove({ group: CORE, resource: "pods", name: podName });
        }
      }
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

    const attached = Effect.gen(function* () {
      const routes = (yield* kube.list(
        { group: CORE, resource: "services" },
        { labelSelector: ATTACHED_LABEL },
      )) as ReadonlyArray<RouteView>;
      const found: GatewayAttached[] = [];
      for (const route of routes) {
        const labels = route.metadata?.labels ?? {};
        const name = labels[ATTACHED_LABEL] ?? "";
        // Only the route Magnesium's own naming gives it, for a name the hub can use.
        if (!isMachineName(name) || route.metadata?.name !== `magnesium-${name}`) continue;
        const paired = labels[ATTACHED_PAIRED_LABEL] === "true";
        const secret = paired
          ? Option.none()
          : yield* kube.get({ group: CORE, resource: "secrets", name: pairingSecretName(name) });
        const encoded =
          secret._tag === "Some"
            ? (secret.value as { readonly data?: Record<string, string> }).data?.[PAIRING_CODE_KEY]
            : undefined;
        const code = encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : "";
        found.push({
          name,
          workload: labels[ATTACHED_WORKLOAD_LABEL] ?? null,
          paired,
          pairingCode: code === "" ? null : code,
        });
      }
      return found;
    });

    const attachedPaired = Effect.fn("Spokes.attachedPaired")(function* (name: string) {
      // The label first: the operator's deploy writes a code only while it's absent.
      yield* kube.apply(
        { group: CORE, resource: "services", name: `magnesium-${name}` },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: `magnesium-${name}`,
            namespace: kube.namespace,
            labels: { [ATTACHED_PAIRED_LABEL]: "true" },
          },
        },
      );
      yield* kube.remove({ group: CORE, resource: "secrets", name: pairingSecretName(name) });
    });

    return Spokes.of({ list, apply, remove, attached, attachedPaired });
  });

/** Every server answers the spoke RPCs; only a gateway can do anything. */
export const notAGatewayLayer = Layer.succeed(
  Spokes,
  Spokes.of({
    list: Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    apply: () => Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    remove: () => Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    attached: Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
    attachedPaired: () => Effect.fail(new SpokeError({ detail: "This server isn't a gateway." })),
  }),
);
