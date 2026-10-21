// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the test keeps the hub's state in a temporary folder and reads its file back.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GatewayAttached,
  type HubMachine,
  type SpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeSpec,
} from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { Fleet } from "../fleet/Fleet.ts";
import { ServerPorts } from "../ports.ts";
import {
  defaultSettingsPorts,
  noThreads,
  testDescriptor,
  testFleet,
  testFleetMachine,
} from "../testing.ts";
import { GatewayClient } from "./gatewayClient.ts";
import { HubMachineAccessError, HubMachines } from "./HubMachines.ts";
import * as HubSpokes from "./HubSpokes.ts";
import * as ModelKeys from "./ModelKeys.ts";
import { HUB_SPOKES_FILE } from "./spokeRecords.ts";

const spec: SpokeSpec = {
  name: "cpu-host-2",
  node: "node-b",
  home: "/home/agent",
  hostname: "cpu-host-2",
  build: null,
  volumeSize: "100Gi",
  opencode: null,
  replicas: 1,
};

/** A hub with access to `gateway`, whose new spokes answer after `upAfter` tries. */
const makeHub = (options: {
  readonly access?: ReadonlyArray<string>;
  readonly upAfter?: number;
  /** The machines whose status says they are gateways. */
  readonly gateways?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-hub-spokes-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const secrets = new Map<string, Uint8Array>();
    const access = new Set(["gateway", ...(options.access ?? [])]);
    const tries = new Map<string, number>();
    const removedAccess: string[] = [];
    const refreshed: string[] = [];
    const applied: Array<{ readonly gateway: string; readonly input: SpokeApplyInput }> = [];
    const removals: Array<{ readonly gateway: string; readonly input: SpokeRemoveInput }> = [];
    const gatewayState = { down: false, empty: false };
    /** Machines the hub has access to that don't answer yet. */
    const silent = new Set<string>();
    /** What the gateway routes to inside workloads' pods, and which routes it marked paired. */
    const routed: GatewayAttached[] = [];
    const markedPaired: string[] = [];
    /** Each machine the hub asked for its spokes. */
    const listed: string[] = [];

    const ports = ServerPorts.of({
      baseDir,
      stateDir: baseDir,
      authenticate: () => Effect.die("unused"),
      authenticateWebSocket: () => Effect.die("unused"),
      environment: Effect.succeed(testDescriptor()),
      threads: noThreads,
      issueBearerSession: () => Effect.die("unused"),
      getSecret: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
      setSecret: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      removeSecret: (name) => Effect.sync(() => void secrets.delete(name)),
      ...defaultSettingsPorts,
    });
    const machine = (name: string): HubMachine => ({
      name,
      label: name,
      environmentId: null,
      access: "ready",
      accessExpiresAt: null,
      online: true,
      source: "deploy",
    });
    const machines = HubMachines.of({
      // Every machine the hub has access to answers, unless the test says otherwise.
      list: Effect.sync(() => ({
        machines: [...access].filter((name) => !silent.has(name)).map(machine),
      })),
      upstream: (name) =>
        access.has(name)
          ? Effect.succeed({
              name,
              url:
                name === "gateway"
                  ? "https://gateway.example"
                  : `https://gateway.example/spokes/${name}`,
              token: "t",
            })
          : Effect.fail(
              new HubMachineAccessError({ name, detail: "The hub has no access to it yet." }),
            ),
      giveAccess: (name, input) =>
        Effect.suspend(() => {
          const count = (tries.get(name) ?? 0) + 1;
          tries.set(name, count);
          if (count <= (options.upAfter ?? 0)) {
            return Effect.fail(
              new HubMachineAccessError({ name, detail: `Could not reach ${name}: not up yet` }),
            );
          }
          if (!("pairingCode" in input) || !/^[0-9A-F]{32}$/.test(input.pairingCode)) {
            return Effect.fail(
              new HubMachineAccessError({
                name,
                detail: "The machine did not accept that credential.",
              }),
            );
          }
          access.add(name);
          return Effect.succeed(machine(name));
        }),
      removeAccess: (name) =>
        Effect.sync(() => {
          access.delete(name);
          removedAccess.push(name);
        }),
      markRejected: () => Effect.void,
      renewDue: Effect.void,
      // The hub's machine list: a gateway and a plain machine.
      names: Effect.succeed(["gateway", "cpu-host-1"]),
      accessChanged: Stream.empty,
      refresh: (name) => Effect.sync(() => void refreshed.push(name)),
      add: () => Effect.die("unused"),
      forget: () => Effect.die("unused"),
      listChanged: Stream.empty,
    });
    const gateways = GatewayClient.of({
      list: (gateway) =>
        Effect.suspend(() => {
          listed.push(gateway);
          return gatewayState.down
            ? Effect.fail(new SpokeError({ detail: `Could not reach the gateway ${gateway}.` }))
            : gatewayState.empty
              ? Effect.succeed([])
              : Effect.succeed([
                  {
                    name: "cpu-host-2",
                    node: "node-b",
                    build: "4d5e6f7081",
                    replicas: 1,
                    ready: true,
                    detail: null,
                  },
                ]);
        }),
      apply: (gateway, input) =>
        Effect.sync(() => {
          applied.push({ gateway, input });
          return {
            name: input.spec.name,
            node: input.spec.node,
            build: null,
            replicas: input.spec.replicas,
            ready: false,
            detail: "Starting.",
          };
        }),
      remove: (gateway, input) => Effect.sync(() => void removals.push({ gateway, input })),
      attached: () => Effect.sync(() => routed.map((entry) => ({ ...entry }))),
      attachedPaired: (_gateway, name) =>
        Effect.sync(() => {
          markedPaired.push(name);
          const index = routed.findIndex((entry) => entry.name === name);
          if (index >= 0) routed[index] = { ...routed[index]!, paired: true, pairingCode: null };
        }),
    });
    const context = yield* Layer.build(
      HubSpokes.layer.pipe(
        Layer.provideMerge(ModelKeys.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerPorts, ports),
            Layer.succeed(HubMachines, machines),
            Layer.succeed(GatewayClient, gateways),
            Layer.succeed(
              Fleet,
              testFleet(
                Effect.succeed([
                  ...(options.gateways ?? []).map((name) =>
                    testFleetMachine(name, { kind: "gateway" }),
                  ),
                  testFleetMachine("cpu-host-1"),
                ]),
              ),
            ),
            NodeServices.layer,
          ),
        ),
      ),
    );
    const records = Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(baseDir, HUB_SPOKES_FILE), "utf8").then(
        (text) =>
          (JSON.parse(text) as { spokes: Array<{ name: string; url: string; keys: string[] }> })
            .spokes,
      ),
    );
    return {
      spokes: Context.get(context, HubSpokes.HubSpokes),
      keys: Context.get(context, ModelKeys.ModelKeys),
      secrets,
      access,
      applied,
      removals,
      removedAccess,
      refreshed,
      records,
      gatewayState,
      routed,
      markedPaired,
      listed,
      silent,
    };
  });

describe("the hub's spokes", () => {
  it.effect("a new spoke gets a one-time code and its keys, and the hub pairs once it is up", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ upAfter: 3 });
      yield* hub.keys.set("LITELLM_API_KEY", "sk-test");

      const added = yield* hub.spokes.apply({
        gateway: "gateway",
        spec,
        keys: ["LITELLM_API_KEY"],
      });
      expect(added).toMatchObject({ name: "cpu-host-2", paired: false, status: { ready: false } });
      const first = hub.applied[0]!;
      expect(first.gateway).toBe("gateway");
      expect(first.input.secrets?.keys).toEqual({ LITELLM_API_KEY: "sk-test" });
      expect(first.input.secrets?.pairingCode).toMatch(/^[0-9A-F]{32}$/);
      expect(yield* hub.records).toEqual([
        expect.objectContaining({
          name: "cpu-host-2",
          url: "https://gateway.example/spokes/cpu-host-2",
          keys: ["LITELLM_API_KEY"],
        }),
      ]);
      expect(hub.refreshed).toEqual(["cpu-host-2"]);

      // Not up for three tries; the fourth pairs, and the code leaves its Secret.
      while (hub.applied.length < 2) yield* TestClock.adjust("5 seconds");
      expect(hub.access.has("cpu-host-2")).toBe(true);
      expect(hub.applied[1]!.input.secrets).toEqual({
        pairingCode: null,
        keys: { LITELLM_API_KEY: "sk-test" },
      });
      expect(yield* hub.spokes.list).toMatchObject([
        { name: "cpu-host-2", paired: true, status: { ready: true }, detail: null },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a machine moved into Kubernetes keeps the hub's access and needs no code", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"] });
      const moved = yield* hub.spokes.apply({
        gateway: "gateway",
        spec: { ...spec, replicas: 0 },
        keys: [],
      });
      expect(moved).toMatchObject({ paired: true, detail: null });
      expect(hub.applied[0]!.input.secrets).toEqual({ pairingCode: null, keys: {} });
    }).pipe(Effect.scoped),
  );

  it.effect("sends a replaced key to every pod that gets it, and to no other", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2", "cpu-host-3"] });
      yield* hub.keys.set("LITELLM_API_KEY", "sk-old");
      yield* hub.spokes.apply({ gateway: "gateway", spec, keys: ["LITELLM_API_KEY"] });
      yield* hub.spokes.apply({
        gateway: "gateway",
        spec: { ...spec, name: "cpu-host-3", hostname: "cpu-host-3" },
        keys: [],
      });
      hub.applied.length = 0;

      yield* hub.keys.set("LITELLM_API_KEY", "sk-new");
      expect(yield* hub.spokes.sendKey("LITELLM_API_KEY")).toEqual(["cpu-host-2"]);
      expect(hub.applied).toEqual([
        {
          gateway: "gateway",
          input: { spec, secrets: { pairingCode: null, keys: { LITELLM_API_KEY: "sk-new" } } },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the build a pod ran before its build changed, for Roll back", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"] });
      yield* hub.spokes.apply({
        gateway: "gateway",
        spec: { ...spec, build: "aaaaaaa" },
        keys: [],
      });
      expect(yield* hub.spokes.previousBuildOf("cpu-host-2")).toBeNull();
      yield* hub.spokes.changeBuild("cpu-host-2", "bbbbbbb", "aaaaaaa");
      expect(yield* hub.spokes.previousBuildOf("cpu-host-2")).toBe("aaaaaaa");
      expect(hub.applied.at(-1)?.input.spec.build).toBe("bbbbbbb");
      // Other changes keep it.
      yield* hub.spokes.apply({
        gateway: "gateway",
        spec: { ...spec, build: "bbbbbbb", node: "node-c" },
        keys: [],
      });
      expect(yield* hub.spokes.previousBuildOf("cpu-host-2")).toBe("aaaaaaa");
      // A build that never came up, undone: the build before stays what it was.
      yield* hub.spokes.changeBuild("cpu-host-2", "ccccccc", "bbbbbbb");
      yield* hub.spokes.changeBuild("cpu-host-2", "bbbbbbb", "ccccccc", "aaaaaaa");
      expect(yield* hub.spokes.previousBuildOf("cpu-host-2")).toBe("aaaaaaa");
      expect(hub.applied.at(-1)?.input.spec.build).toBe("bbbbbbb");
      expect(yield* hub.spokes.kindOf("cpu-host-2")).toBe("pod");
      expect(yield* hub.spokes.kindOf("nowhere")).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a key the hub doesn't hold, and a gateway that isn't one", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({});
      const noKey = yield* hub.spokes
        .apply({ gateway: "gateway", spec, keys: ["MISSING_KEY"] })
        .pipe(Effect.flip);
      expect(noKey.detail).toContain("MISSING_KEY");
      const noGateway = yield* hub.spokes
        .apply({ gateway: "elsewhere", spec, keys: [] })
        .pipe(Effect.flip);
      expect(noGateway.detail).toContain("no access to the gateway elsewhere");
      const itself = yield* hub.spokes
        .apply({ gateway: "cpu-host-2", spec, keys: [] })
        .pipe(Effect.flip);
      expect(itself.detail).toContain("isn't a gateway");
      expect(hub.applied).toEqual([]);
      // A model key's value never comes back.
      yield* hub.keys.set("LITELLM_API_KEY", "sk-test");
      expect(yield* hub.keys.names).toEqual(["LITELLM_API_KEY"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "removing keeps the hub's access while the home stays, and says when a gateway is away",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub({ access: ["cpu-host-2"] });
        yield* hub.spokes.apply({ gateway: "gateway", spec, keys: [] });

        hub.gatewayState.down = true;
        expect(yield* hub.spokes.list).toMatchObject([
          { name: "cpu-host-2", status: null, detail: "Could not reach the gateway gateway." },
        ]);
        hub.gatewayState.down = false;
        // The gateway answers, with nothing running for it: say that, not that it's away.
        hub.gatewayState.empty = true;
        expect((yield* hub.spokes.list)[0]?.detail).toContain("Nothing runs for it in the cluster");
        hub.gatewayState.empty = false;

        yield* hub.spokes.remove({ name: "cpu-host-2", keepVolume: true });
        expect(hub.removals).toEqual([
          { gateway: "gateway", input: { name: "cpu-host-2", keepVolume: true } },
        ]);
        expect(hub.removedAccess).toEqual([]);
        expect(yield* hub.records).toEqual([]);

        yield* hub.spokes.apply({ gateway: "gateway", spec, keys: [] });
        yield* hub.spokes.remove({ name: "cpu-host-2", keepVolume: false });
        expect(hub.removedAccess).toEqual(["cpu-host-2"]);
        const gone = yield* hub.spokes
          .remove({ name: "cpu-host-2", keepVolume: false })
          .pipe(Effect.flip);
        expect(gone.detail).toContain("no spoke named cpu-host-2");
      }).pipe(Effect.scoped),
  );
});

describe("machines attached to workloads", () => {
  it.effect("a moved machine keeps the hub's access, and detaching is the way back out", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"] });
      const attached = yield* hub.spokes.attach({
        name: "cpu-host-2",
        gateway: "gateway",
        pairingCode: null,
      });
      expect(attached).toMatchObject({ paired: true, detail: null });
      expect(yield* hub.spokes.attached).toEqual([
        { name: "cpu-host-2", gateway: "gateway", workload: null, paired: true, detail: null },
      ]);
      expect(hub.refreshed).toEqual(["cpu-host-2"]);
      // The workload's deploy runs it: the hub won't start a spoke in its name.
      const taken = yield* hub.spokes
        .apply({ gateway: "gateway", spec, keys: [] })
        .pipe(Effect.flip);
      expect(taken.detail).toContain("attached to a workload");

      yield* hub.spokes.detach({ name: "cpu-host-2", keepAccess: false });
      expect(hub.removedAccess).toEqual(["cpu-host-2"]);
      expect(yield* hub.spokes.attached).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("a new one pairs with the code from its Secret once it answers", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ upAfter: 2 });
      const attached = yield* hub.spokes.attach({
        name: "notebook",
        gateway: "gateway",
        pairingCode: "0123456789ABCDEF0123456789ABCDEF",
      });
      expect(attached).toMatchObject({ paired: false });
      while (!hub.access.has("notebook")) yield* TestClock.adjust("5 seconds");
      expect(yield* hub.spokes.attached).toMatchObject([{ name: "notebook", paired: true }]);
    }).pipe(Effect.scoped),
  );

  it.effect("won't attach over a spoke the hub runs, or through a machine it can't use", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({});
      yield* hub.spokes.apply({ gateway: "gateway", spec, keys: [] });
      const over = yield* hub.spokes
        .attach({ name: "cpu-host-2", gateway: "gateway", pairingCode: null })
        .pipe(Effect.flip);
      expect(over.detail).toContain("Remove it first");
      const noGateway = yield* hub.spokes
        .attach({ name: "notebook", gateway: "elsewhere", pairingCode: null })
        .pipe(Effect.flip);
      expect(noGateway.detail).toContain("no access to the gateway elsewhere");
    }).pipe(Effect.scoped),
  );
});

describe("machines found through their gateway", () => {
  const code = "0123456789ABCDEF0123456789ABCDEF";

  it.effect("asks only the machines that say they are gateways", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ gateways: ["gateway"] });
      hub.routed.push({
        name: "notebook",
        workload: "notebook-ws",
        paired: false,
        pairingCode: null,
      });
      expect(yield* hub.spokes.gateways).toEqual(["gateway"]);
      yield* hub.spokes.discover;
      expect(yield* hub.spokes.attached).toMatchObject([{ name: "notebook", gateway: "gateway" }]);
      // cpu-host-1, a plain machine, is never dialled to ask for its spokes.
      expect(hub.listed).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("a new one joins by itself and pairs with the code its workload's deploy left", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ upAfter: 2, gateways: ["gateway"] });
      hub.routed.push({
        name: "notebook",
        workload: "notebook-ws",
        paired: false,
        pairingCode: code,
      });
      yield* hub.spokes.discover;
      expect(yield* hub.spokes.attached).toMatchObject([
        { name: "notebook", gateway: "gateway", workload: "notebook-ws", paired: false },
      ]);
      expect(hub.refreshed).toContain("notebook");
      while (!hub.access.has("notebook")) yield* TestClock.adjust("5 seconds");
      // Paired: the gateway marks its route, so the spent code isn't written again.
      while (hub.markedPaired.length === 0) yield* TestClock.adjust("1 second");
      expect(hub.markedPaired).toEqual(["notebook"]);
      expect(yield* hub.spokes.attached).toMatchObject([{ name: "notebook", paired: true }]);
    }).pipe(Effect.scoped),
  );

  it.effect("a moved machine the hub already has needs no code", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"], gateways: ["gateway"] });
      hub.routed.push({
        name: "cpu-host-2",
        workload: "render",
        paired: false,
        pairingCode: null,
      });
      yield* hub.spokes.discover;
      expect(yield* hub.spokes.attached).toEqual([
        { name: "cpu-host-2", gateway: "gateway", workload: "render", paired: true, detail: null },
      ]);
      expect(hub.markedPaired).toEqual(["cpu-host-2"]);
    }).pipe(Effect.scoped),
  );

  it.effect("marks a moved machine's route paired only once it answers", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"], gateways: ["gateway"] });
      hub.silent.add("cpu-host-2");
      hub.routed.push({
        name: "cpu-host-2",
        workload: "render",
        paired: false,
        pairingCode: null,
      });
      yield* hub.spokes.discover;
      expect(hub.markedPaired).toEqual([]);
      hub.silent.delete("cpu-host-2");
      yield* hub.spokes.discover;
      expect(hub.markedPaired).toEqual(["cpu-host-2"]);
    }).pipe(Effect.scoped),
  );

  it.effect("one whose route goes is said to be gone, never removed, and only then detaches", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ access: ["cpu-host-2"], gateways: ["gateway"] });
      hub.routed.push({ name: "cpu-host-2", workload: "render", paired: true, pairingCode: null });
      yield* hub.spokes.discover;
      // Still routed: its workload's deploy is the way out.
      const refused = yield* hub.spokes
        .detach({ name: "cpu-host-2", keepAccess: false })
        .pipe(Effect.flip);
      expect(refused.detail).toContain("still runs Magnesium");

      hub.routed.splice(0);
      yield* hub.spokes.discover;
      const [gone] = yield* hub.spokes.attached;
      expect(gone?.detail).toContain("no longer routes to it");
      // Going back to bare metal: the record goes, the hub's access stays.
      yield* hub.spokes.detach({ name: "cpu-host-2", keepAccess: true });
      expect(yield* hub.spokes.attached).toEqual([]);
      expect(hub.access.has("cpu-host-2")).toBe(true);
    }).pipe(Effect.scoped),
  );
});
