// @effect-diagnostics preferSchemaOverJson:off - the fake API server reads and writes JSON as the cluster does.
import type { SpokeSpec } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { KubeApi, make as makeKube } from "./kube.ts";
import {
  isLocalImage,
  type RenderContext,
  renderWorkload,
  renderSecret,
  renderVolume,
  spokeStatusOf,
} from "./manifests.ts";
import * as Spokes from "./Spokes.ts";

const spec: SpokeSpec = {
  name: "cpu-host-2",
  node: "node-b",
  home: "/home/agent",
  hostname: "cpu-host-2",
  build: null,
  volumeSize: "100Gi",
  opencode: { baseUrl: "https://litellm.example.com/v1", models: ["model-a", "model-b"] },
  replicas: 1,
};

const context: RenderContext = {
  namespace: "magnesium",
  image: (build) => `localhost/magnesium:${build}`,
  defaultBuild: "4d5e6f7081",
  storageClass: null,
  timeZone: null,
};

describe("a spoke's objects", () => {
  it("run it as the contract says: restricted, one pod at a time, its home where it was", () => {
    const deployment = renderWorkload(spec, context);
    // A StatefulSet: one pod with a stable name, magnesium-<name>-0, never two at once.
    expect(deployment.kind).toBe("StatefulSet");
    expect(deployment.metadata.name).toBe("magnesium-cpu-host-2");
    expect(deployment.spec.serviceName).toBe("magnesium-cpu-host-2");
    expect(deployment.spec.replicas).toBe(1);
    const pod = deployment.spec.template.spec;
    expect(pod).toMatchObject({
      automountServiceAccountToken: false,
      hostname: "cpu-host-2",
      nodeSelector: { "kubernetes.io/hostname": "node-b" },
      securityContext: {
        runAsUser: 10001,
        runAsNonRoot: true,
        fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    const container = pod.containers[0]!;
    expect(container.image).toBe("localhost/magnesium:4d5e6f7081");
    // An image loaded onto the node is never pulled; one from a registry is.
    expect(container.imagePullPolicy).toBe("Never");
    expect(
      renderWorkload(spec, { ...context, image: (build) => `ghcr.io/owner/magnesium:${build}` })
        .spec.template.spec.containers[0]!.imagePullPolicy,
    ).toBeUndefined();
    expect(isLocalImage("magnesium:4d5e6f7081")).toBe(true);
    expect(isLocalImage("localhost:5000/magnesium:4d5e6f7081")).toBe(false);
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container.env).toEqual([
      { name: "HOME", value: "/home/agent" },
      { name: "MAGNESIUM_MACHINE", value: "cpu-host-2" },
      // Where it runs, from Kubernetes, for Fleet.
      { name: "MAGNESIUM_NODE", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
      { name: "MAGNESIUM_OPENCODE_BASE_URL", value: "https://litellm.example.com/v1" },
      { name: "MAGNESIUM_OPENCODE_MODELS", value: "model-a,model-b" },
    ]);
    // Keys reach the pod only by name, from its Secret.
    expect(container.envFrom).toEqual([
      { secretRef: { name: "magnesium-cpu-host-2", optional: true } },
    ]);
    expect(container.volumeMounts).toContainEqual({ name: "home", mountPath: "/home/agent" });
    expect(
      renderWorkload({ ...spec, build: "5e6f708192" }, context).spec.template.spec.containers[0]!
        .image,
    ).toBe("localhost/magnesium:5e6f708192");
    // A gateway with a time zone gives it to every spoke (D64).
    expect(
      renderWorkload(spec, { ...context, timeZone: "Europe/Berlin" }).spec.template.spec
        .containers[0]!.env,
    ).toContainEqual({ name: "MAGNESIUM_TIMEZONE", value: "Europe/Berlin" });
  });

  it("keep keys and the pairing code in the Secret, and size the volume as asked", () => {
    const secret = renderSecret(
      spec,
      { pairingCode: "PAIR-WITH-HUB-0123456789", keys: { LITELLM_API_KEY: "sk-test" } },
      context,
    );
    expect(Object.keys(secret.data).toSorted()).toEqual([
      "LITELLM_API_KEY",
      "MAGNESIUM_HUB_PAIRING_CODE",
    ]);
    expect(Buffer.from(secret.data.LITELLM_API_KEY!, "base64").toString()).toBe("sk-test");
    expect(renderVolume(spec, context).spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "100Gi" } },
    });
    expect(renderVolume(spec, { ...context, storageClass: "local-retain" }).spec).toMatchObject({
      storageClassName: "local-retain",
    });
  });

  it("read back as a status, with the cluster's refusal when it has one", () => {
    const deployment = renderWorkload(spec, context);
    expect(spokeStatusOf({ ...deployment, status: { readyReplicas: 1 } })).toEqual({
      name: "cpu-host-2",
      node: "node-b",
      build: "4d5e6f7081",
      replicas: 1,
      ready: true,
      detail: null,
    });
    const refused = spokeStatusOf({
      ...deployment,
      status: {
        conditions: [
          {
            type: "ReplicaFailure",
            status: "True",
            message: 'pods "magnesium-cpu-host-2-x" is forbidden: node node-z is not allowed',
          },
        ],
      },
    });
    expect(refused).toMatchObject({ ready: false, detail: expect.stringContaining("not allowed") });
    expect(
      spokeStatusOf({ ...deployment, spec: { ...deployment.spec, replicas: 0 } }),
    ).toMatchObject({ replicas: 0, detail: "Stopped." });
    expect(spokeStatusOf({ metadata: { labels: {} } })).toBeNull();
    // Not available yet is starting, whatever Kubernetes calls it.
    expect(
      spokeStatusOf({
        ...deployment,
        status: {
          conditions: [
            {
              type: "Available",
              status: "False",
              message: "Deployment does not have minimum availability.",
            },
          ],
        },
      }),
    ).toMatchObject({ ready: false, detail: "Starting." });
  });
});

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly contentType: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A Kubernetes API that keeps what is applied, and refuses nodes outside `allowed`. */
const fakeCluster = (allowed: ReadonlyArray<string>, options: { podsLinger?: boolean } = {}) => {
  const calls: Call[] = [];
  const objects = new Map<string, unknown>();
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const text =
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined;
      const body = text === undefined ? undefined : (JSON.parse(text) as unknown);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        contentType: request.body._tag === "Uint8Array" ? request.body.contentType : undefined,
        authorization: request.headers.authorization,
        body,
      });
      const reply = (status: number, value: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      if (request.method === "PATCH") {
        const node = (
          body as { spec?: { template?: { spec?: { nodeSelector?: Record<string, string> } } } }
        )?.spec?.template?.spec?.nodeSelector?.["kubernetes.io/hostname"];
        if (node !== undefined && !allowed.includes(node)) {
          return reply(422, {
            kind: "Status",
            message: `statefulsets.apps is forbidden: ValidatingAdmissionPolicy denied request: node ${node} is not allowed`,
          });
        }
        objects.set(url.pathname, body);
        return reply(200, body);
      }
      if (request.method === "DELETE") {
        objects.delete(url.pathname);
        // As the garbage collector does: a workload's pods go with it (unless
        // the test stops them itself, as a pod that takes a while to end).
        const owner = url.pathname.split("/").at(-1)!;
        for (const path of options.podsLinger ? [] : Array.from(objects.keys())) {
          if (path.includes("/pods/") && path.split("/").at(-1)!.startsWith(`${owner}-`)) {
            objects.delete(path);
          }
        }
        return reply(200, { kind: "Status", status: "Success" });
      }
      if (objects.has(url.pathname)) return reply(200, objects.get(url.pathname));
      const items = [...objects.entries()]
        .filter(([path]) => path.startsWith(`${url.pathname}/`))
        .map(([, value]) => value as Record<string, any>)
        .filter((item) => {
          const label = url.searchParams.get("labelSelector");
          const field = url.searchParams.get("fieldSelector");
          if (label?.startsWith("magnesium.machine=")) {
            return item.metadata?.labels?.["magnesium.machine"] === label.split("=")[1];
          }
          if (label !== null && label !== undefined && !label.includes("=")) {
            return item.metadata?.labels?.[label] !== undefined;
          }
          if (field?.startsWith("involvedObject.name=")) {
            return item.involvedObject?.name === field.split("=")[1];
          }
          return true;
        });
      if (items.length > 0 || /\/(statefulsets|deployments|pods|events)$/.test(url.pathname)) {
        return reply(200, { kind: "List", items });
      }
      return reply(404, { kind: "Status", message: "not found" });
    }),
  );
  const kube = Layer.effect(
    KubeApi,
    makeKube({
      server: "https://10.43.0.1:443", // public-check: allow (K3s's default API address)
      namespace: "magnesium",
      token: Effect.succeed("sa-token"),
    }),
  ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
  const spokes = Layer.effect(
    Spokes.Spokes,
    Spokes.make({
      image: context.image,
      defaultBuild: "4d5e6f7081",
      storageClass: null,
      timeZone: null,
    }),
  ).pipe(Layer.provide(kube));
  return { calls, objects, spokes };
};

describe("a gateway's spokes", () => {
  it.effect("applies a spoke as Magnesium's own objects, with server-side apply", () => {
    const cluster = fakeCluster(["node-b"]);
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      const status = yield* spokes.apply({
        spec,
        secrets: { pairingCode: "PAIR-WITH-HUB-0123456789", keys: {} },
      });
      expect(status).toMatchObject({ name: "cpu-host-2", node: "node-b", ready: false });
      expect(cluster.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "PATCH /api/v1/namespaces/magnesium/persistentvolumeclaims/magnesium-cpu-host-2-home",
        "PATCH /api/v1/namespaces/magnesium/secrets/magnesium-cpu-host-2",
        "PATCH /api/v1/namespaces/magnesium/services/magnesium-cpu-host-2",
        // No Deployment from before StatefulSets to retire.
        "GET /apis/apps/v1/namespaces/magnesium/deployments/magnesium-cpu-host-2",
        "PATCH /apis/apps/v1/namespaces/magnesium/statefulsets/magnesium-cpu-host-2",
      ]);
      for (const call of cluster.calls.filter((call) => call.method === "PATCH")) {
        expect(call.contentType).toBe("application/apply-patch+yaml");
        expect(call.query).toEqual({ fieldManager: "magnesium", force: "true" });
        expect(call.authorization).toBe("Bearer sa-token");
      }

      // Without new secrets, the Secret is left as it is; the spoke is listed.
      cluster.calls.length = 0;
      yield* spokes.apply({ spec: { ...spec, replicas: 0 }, secrets: null });
      expect(
        cluster.calls.some((call) => call.method === "PATCH" && call.path.includes("/secrets/")),
      ).toBe(false);
      expect(yield* spokes.list).toMatchObject([
        { name: "cpu-host-2", replicas: 0, detail: "Stopped." },
      ]);

      // Removing it keeps its home unless told otherwise.
      yield* spokes.remove({ name: "cpu-host-2", keepVolume: true });
      expect([...cluster.objects.keys()]).toEqual([
        "/api/v1/namespaces/magnesium/persistentvolumeclaims/magnesium-cpu-host-2-home",
      ]);
      expect(yield* spokes.list).toEqual([]);
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect("rolls a spoke's pod when its Secret changes, and only then", () => {
    const cluster = fakeCluster(["node-b"]);
    const fingerprint = () => {
      const deployment = cluster.objects.get(
        "/apis/apps/v1/namespaces/magnesium/statefulsets/magnesium-cpu-host-2",
      ) as { spec: { template: { metadata: { annotations?: Record<string, string> } } } };
      return deployment.spec.template.metadata.annotations?.["magnesium.dev/secret"];
    };
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      yield* spokes.apply({ spec, secrets: { pairingCode: "PAIR-WITH-HUB-0123456789", keys: {} } });
      const first = fingerprint();
      expect(first).toMatch(/^[0-9a-f]{8}$/);
      // Paired: the code leaves the Secret, so the pod restarts without it.
      yield* spokes.apply({ spec, secrets: { pairingCode: null, keys: {} } });
      const second = fingerprint();
      expect(second).not.toBe(first);
      // A change that sends no secrets keeps the Secret, and the pod with it.
      yield* spokes.apply({ spec: { ...spec, build: "5e6f708192" }, secrets: null });
      expect(fingerprint()).toBe(second);
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect("moves a spoke from its old Deployment to a StatefulSet, one pod at a time", () => {
    const cluster = fakeCluster(["node-b"]);
    const base = "/apis/apps/v1/namespaces/magnesium";
    cluster.objects.set(`${base}/deployments/magnesium-cpu-host-2`, {
      metadata: {
        labels: { "app.kubernetes.io/name": "magnesium-spoke", "magnesium.machine": "cpu-host-2" },
      },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    });
    cluster.objects.set("/api/v1/namespaces/magnesium/pods/magnesium-cpu-host-2-7c9f-x2k4p", {
      metadata: { labels: { "magnesium.machine": "cpu-host-2" } },
    });
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      // Before its next change it still lists, from the Deployment.
      expect(yield* spokes.list).toMatchObject([{ name: "cpu-host-2", ready: true }]);
      yield* spokes.apply({ spec, secrets: null });
      const order = cluster.calls
        .filter((call) => call.method !== "GET" || call.path.endsWith("/pods"))
        .map((call) => `${call.method} ${call.path.replace(base, "")}`);
      // The old Deployment and its pod go before the StatefulSet starts its own.
      expect(order.indexOf("DELETE /deployments/magnesium-cpu-host-2")).toBeGreaterThan(-1);
      expect(order.indexOf("DELETE /deployments/magnesium-cpu-host-2")).toBeLessThan(
        order.indexOf("PATCH /statefulsets/magnesium-cpu-host-2"),
      );
      expect(cluster.objects.has(`${base}/deployments/magnesium-cpu-host-2`)).toBe(false);
      expect(cluster.objects.has(`${base}/statefulsets/magnesium-cpu-host-2`)).toBe(true);
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect("finishes a change even when the hub stops waiting for it", () => {
    const cluster = fakeCluster(["node-b"], { podsLinger: true });
    const base = "/apis/apps/v1/namespaces/magnesium";
    const oldPod = "/api/v1/namespaces/magnesium/pods/magnesium-cpu-host-2-7c9f-x2k4p";
    cluster.objects.set(`${base}/deployments/magnesium-cpu-host-2`, {
      metadata: { labels: { "magnesium.machine": "cpu-host-2" } },
      spec: { replicas: 1 },
      status: { readyReplicas: 1 },
    });
    cluster.objects.set(oldPod, { metadata: { labels: { "magnesium.machine": "cpu-host-2" } } });
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      const applying = yield* Effect.forkChild(spokes.apply({ spec, secrets: null }));
      yield* TestClock.adjust("1 second");
      // The old Deployment is gone, and the change waits for its pod to stop.
      expect(cluster.objects.has(`${base}/deployments/magnesium-cpu-host-2`)).toBe(false);
      // The hub hangs up, as when it restarts mid-change.
      const hangingUp = yield* Effect.forkChild(Fiber.interrupt(applying));
      cluster.objects.delete(oldPod);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(hangingUp);
      expect(cluster.objects.has(`${base}/statefulsets/magnesium-cpu-host-2`)).toBe(true);
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect("shows why a spoke isn't starting, from the cluster's events", () => {
    const cluster = fakeCluster(["node-b"]);
    cluster.objects.set("/api/v1/namespaces/magnesium/events/a", {
      type: "Warning",
      involvedObject: { name: "magnesium-cpu-host-2" },
      message:
        "create Pod magnesium-cpu-host-2-0 failed: images may only come from localhost/magnesium",
      lastTimestamp: "2026-10-17T03:00:00Z",
    });
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      yield* spokes.apply({ spec, secrets: null });
      expect(yield* spokes.list).toMatchObject([
        {
          name: "cpu-host-2",
          ready: false,
          detail: expect.stringContaining("localhost/magnesium"),
        },
      ]);
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect("passes the cluster's refusal on in its own words", () => {
    const cluster = fakeCluster(["node-b"]);
    return Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      const refused = yield* spokes
        .apply({ spec: { ...spec, node: "gpu-node" }, secrets: null })
        .pipe(Effect.flip);
      expect(refused.detail).toContain("node gpu-node is not allowed");
    }).pipe(Effect.provide(cluster.spokes));
  });

  it.effect(
    "lists the machines an operator routes to in workloads, and spends a code once paired",
    () => {
      const cluster = fakeCluster(["node-b"]);
      const core = "/api/v1/namespaces/magnesium";
      const route = (name: string, labels: Record<string, string>) =>
        cluster.objects.set(`${core}/services/${name}`, {
          metadata: { name, labels },
          spec: { type: "ExternalName" },
        });
      route("magnesium-notebook", {
        "magnesium.dev/attached": "notebook",
        "magnesium.dev/workload": "notebook-ws",
      });
      route("magnesium-render", {
        "magnesium.dev/attached": "render",
        "magnesium.dev/paired": "true",
      });
      // A route whose name doesn't match its label isn't one Magnesium's naming made.
      route("someone-else", { "magnesium.dev/attached": "elsewhere" });
      cluster.objects.set(`${core}/secrets/magnesium-notebook-pairing`, {
        data: {
          MAGNESIUM_HUB_PAIRING_CODE: Buffer.from("0123456789ABCDEF0123456789ABCDEF").toString(
            "base64",
          ),
        },
      });
      return Effect.gen(function* () {
        const spokes = yield* Spokes.Spokes;
        expect(yield* spokes.attached).toEqual([
          {
            name: "notebook",
            workload: "notebook-ws",
            paired: false,
            pairingCode: "0123456789ABCDEF0123456789ABCDEF",
          },
          { name: "render", workload: null, paired: true, pairingCode: null },
        ]);
        yield* spokes.attachedPaired("notebook");
        const writes = cluster.calls
          .filter((call) => call.method !== "GET")
          .map((call) => `${call.method} ${call.path.replace(core, "")}`);
        // The label first, so the operator's deploy never writes the spent code again.
        expect(writes).toEqual([
          "PATCH /services/magnesium-notebook",
          "DELETE /secrets/magnesium-notebook-pairing",
        ]);
        const patch = cluster.calls.find((call) => call.method === "PATCH")!;
        expect(patch.body).toMatchObject({
          metadata: { labels: { "magnesium.dev/paired": "true" } },
        });
      }).pipe(Effect.provide(cluster.spokes));
    },
  );

  it.effect("on a server that isn't a gateway, says so", () =>
    Effect.gen(function* () {
      const spokes = yield* Spokes.Spokes;
      const refused = yield* spokes.list.pipe(Effect.flip);
      expect(refused.detail).toBe("This server isn't a gateway.");
    }).pipe(Effect.provide(Spokes.notAGatewayLayer)),
  );
});
