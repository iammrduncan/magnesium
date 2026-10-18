import type { SpokeSecrets, SpokeSpec, SpokeStatus } from "@magnesium/contracts";

/**
 * A spoke's Kubernetes objects, rendered from its spec the way
 * `magnesium/deploy/kubernetes/spoke.yaml` lays them out: a volume for its
 * home, a Secret for its keys, a StatefulSet and a Service. Pure, so the shape
 * the cluster gets is tested here.
 */

export const SPOKE_APP = "magnesium-spoke";
const MANAGED_BY = "magnesium";

export interface SpokeObjectNames {
  /** The StatefulSet; its one pod is `<workload>-0`. */
  readonly workload: string;
  /** The Deployment a spoke ran as before StatefulSets, removed when it is next applied. */
  readonly legacyDeployment: string;
  readonly service: string;
  readonly secret: string;
  readonly volume: string;
}

export const spokeObjectNames = (name: string): SpokeObjectNames => ({
  workload: `magnesium-${name}`,
  legacyDeployment: `magnesium-${name}`,
  service: `magnesium-${name}`,
  secret: `magnesium-${name}`,
  volume: `magnesium-${name}-home`,
});

export interface RenderContext {
  readonly namespace: string;
  /** The image for a build. */
  readonly image: (build: string) => string;
  /** The build a spec without one runs: the gateway's own. */
  readonly defaultBuild: string;
  /** The storage class for new volumes; null takes the namespace's default. */
  readonly storageClass: string | null;
  /** The time zone every spoke keeps, the gateway's own (D64); null for none set. */
  readonly timeZone: string | null;
}

const labels = (name: string) => ({
  "app.kubernetes.io/name": SPOKE_APP,
  "app.kubernetes.io/managed-by": MANAGED_BY,
  "magnesium.machine": name,
});

const HEALTH = { path: "/.well-known/t3/environment", port: "http" } as const;

export const renderVolume = (spec: SpokeSpec, context: RenderContext) => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: {
    name: spokeObjectNames(spec.name).volume,
    namespace: context.namespace,
    labels: labels(spec.name),
  },
  spec: {
    accessModes: ["ReadWriteOnce"],
    ...(context.storageClass === null ? {} : { storageClassName: context.storageClass }),
    resources: { requests: { storage: spec.volumeSize } },
  },
});

/** The Secret's data: names to base64 values, as Kubernetes stores them. */
export const renderSecret = (spec: SpokeSpec, secrets: SpokeSecrets, context: RenderContext) => {
  const values: Record<string, string> = { ...secrets.keys };
  if (secrets.pairingCode !== null) values.MAGNESIUM_HUB_PAIRING_CODE = secrets.pairingCode;
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: spokeObjectNames(spec.name).secret,
      namespace: context.namespace,
      labels: labels(spec.name),
    },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
    ),
  };
};

/**
 * A short fingerprint of a Secret's data. A pod reads its Secret only when it
 * starts, so the Deployment carries this and rolls when the Secret changes: a
 * new pairing code or key then takes effect.
 */
export const secretFingerprint = (data: Readonly<Record<string, string>>): string => {
  let hash = 0x811c9dc5;
  for (const [key, value] of Object.entries(data).toSorted(([a], [b]) => a.localeCompare(b))) {
    for (const char of `${key}=${value};`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
};

export const SECRET_FINGERPRINT = "magnesium.dev/secret";

/**
 * The spoke's one pod, as a StatefulSet: its pod has a stable name,
 * `magnesium-<name>-0`, and a rollout removes the old pod before it starts
 * the next, so its SQLite database never has two writers.
 */
export const renderWorkload = (
  spec: SpokeSpec,
  context: RenderContext,
  /** The spoke's Secret's fingerprint; null leaves it out. */
  secret: string | null = null,
) => {
  const names = spokeObjectNames(spec.name);
  const env: Array<
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly valueFrom: { readonly fieldRef: { readonly fieldPath: string } };
      }
  > = [
    { name: "HOME", value: spec.home },
    { name: "MAGNESIUM_MACHINE", value: spec.name },
    // Where it runs, for Fleet: its name doesn't say.
    { name: "MAGNESIUM_NODE", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
  ];
  // A scheduled task's 09:00 means the same time on every server.
  if (context.timeZone !== null) env.push({ name: "MAGNESIUM_TIMEZONE", value: context.timeZone });
  if (spec.opencode !== null) {
    env.push(
      { name: "MAGNESIUM_OPENCODE_BASE_URL", value: spec.opencode.baseUrl },
      { name: "MAGNESIUM_OPENCODE_MODELS", value: spec.opencode.models.join(",") },
    );
  }
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name: names.workload, namespace: context.namespace, labels: labels(spec.name) },
    spec: {
      replicas: spec.replicas,
      serviceName: names.service,
      updateStrategy: { type: "RollingUpdate" },
      selector: {
        matchLabels: { "app.kubernetes.io/name": SPOKE_APP, "magnesium.machine": spec.name },
      },
      template: {
        metadata: {
          labels: labels(spec.name),
          ...(secret === null ? {} : { annotations: { [SECRET_FINGERPRINT]: secret } }),
        },
        spec: {
          automountServiceAccountToken: false,
          hostname: spec.hostname,
          nodeSelector: { "kubernetes.io/hostname": spec.node },
          securityContext: {
            runAsUser: 10001,
            runAsGroup: 10001,
            runAsNonRoot: true,
            fsGroup: 10001,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          terminationGracePeriodSeconds: 30,
          containers: [
            {
              name: "magnesium",
              image: context.image(spec.build ?? context.defaultBuild),
              env,
              envFrom: [{ secretRef: { name: names.secret, optional: true } }],
              ports: [{ name: "http", containerPort: 3773 }],
              startupProbe: { httpGet: HEALTH, periodSeconds: 5, failureThreshold: 60 },
              readinessProbe: { httpGet: HEALTH, periodSeconds: 10 },
              livenessProbe: { httpGet: HEALTH, periodSeconds: 20, failureThreshold: 6 },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: { requests: { cpu: "500m", memory: "1Gi" } },
              volumeMounts: [
                { name: "home", mountPath: spec.home },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "home", persistentVolumeClaim: { claimName: names.volume } },
            { name: "tmp", emptyDir: {} },
          ],
        },
      },
    },
  };
};

export const renderService = (spec: SpokeSpec, context: RenderContext) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: {
    name: spokeObjectNames(spec.name).service,
    namespace: context.namespace,
    labels: labels(spec.name),
  },
  spec: {
    type: "ClusterIP",
    selector: { "app.kubernetes.io/name": SPOKE_APP, "magnesium.machine": spec.name },
    ports: [{ name: "http", port: 3773, targetPort: "http" }],
  },
});

/** The parts of a spoke's StatefulSet (or its old Deployment) the gateway reads back. */
export interface WorkloadView {
  readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: {
    readonly replicas?: number;
    readonly template?: {
      readonly spec?: {
        readonly nodeSelector?: Readonly<Record<string, string>>;
        readonly containers?: ReadonlyArray<{ readonly image?: string }>;
      };
    };
  };
  readonly status?: {
    readonly readyReplicas?: number;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly message?: string;
    }>;
  };
}

/**
 * A spoke's status from its workload; null for one that isn't a spoke.
 * `warning` is the cluster's latest warning about it, such as an admission
 * refusal, which a StatefulSet reports only as an event.
 */
export const spokeStatusOf = (
  deployment: WorkloadView,
  warning: string | null = null,
): SpokeStatus | null => {
  const name = deployment.metadata?.labels?.["magnesium.machine"];
  if (name === undefined) return null;
  const replicas = deployment.spec?.replicas ?? 1;
  const ready = (deployment.status?.readyReplicas ?? 0) >= 1;
  const image = deployment.spec?.template?.spec?.containers?.[0]?.image ?? "";
  const build = /:([0-9a-f]{7,40})$/.exec(image)?.[1] ?? null;
  // The cluster's refusal (a node outside the list, say) lands on ReplicaFailure,
  // and a rollout that gave up on Progressing. Not available yet is just starting.
  const problem = (deployment.status?.conditions ?? []).find(
    (condition) =>
      (condition.type === "ReplicaFailure" && condition.status === "True") ||
      (condition.type === "Progressing" && condition.status === "False"),
  );
  return {
    name,
    node: deployment.spec?.template?.spec?.nodeSelector?.["kubernetes.io/hostname"] ?? null,
    build,
    replicas,
    ready,
    detail:
      replicas === 0 ? "Stopped." : ready ? null : (problem?.message ?? warning ?? "Starting."),
  };
};
