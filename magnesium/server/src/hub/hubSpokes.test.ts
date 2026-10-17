// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the test keeps the hub's state in a temporary folder and reads its file back.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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

import { ServerPorts } from "../ports.ts";
import { defaultSettingsPorts, noThreads, testDescriptor } from "../testing.ts";
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
const makeHub = (options: { readonly access?: ReadonlyArray<string>; readonly upAfter?: number }) =>
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
    });
    const machines = HubMachines.of({
      list: Effect.succeed({ machines: [] }),
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
      names: Effect.succeed([]),
      accessChanged: Stream.empty,
      refresh: (name) => Effect.sync(() => void refreshed.push(name)),
    });
    const gateways = GatewayClient.of({
      list: (gateway) =>
        gatewayState.down
          ? Effect.fail(new SpokeError({ detail: `Could not reach the gateway ${gateway}.` }))
          : gatewayState.empty
            ? Effect.succeed([])
            : Effect.succeed([
                {
                  name: "cpu-host-2",
                  node: "node-b",
                  build: "f2fbc55f42",
                  replicas: 1,
                  ready: true,
                  detail: null,
                },
              ]),
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
    });
    const context = yield* Layer.build(
      HubSpokes.layer.pipe(
        Layer.provideMerge(ModelKeys.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerPorts, ports),
            Layer.succeed(HubMachines, machines),
            Layer.succeed(GatewayClient, gateways),
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
    };
  });

describe("the hub's spokes", () => {
  it.effect("a new spoke gets a one-time code and its keys, and the hub pairs once it is up", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ upAfter: 3 });
      yield* hub.keys.set("LITELLM_API_KEY", "sk-lab");

      const added = yield* hub.spokes.apply({
        gateway: "gateway",
        spec,
        keys: ["LITELLM_API_KEY"],
      });
      expect(added).toMatchObject({ name: "cpu-host-2", paired: false, status: { ready: false } });
      const first = hub.applied[0]!;
      expect(first.gateway).toBe("gateway");
      expect(first.input.secrets?.keys).toEqual({ LITELLM_API_KEY: "sk-lab" });
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
        keys: { LITELLM_API_KEY: "sk-lab" },
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
      yield* hub.keys.set("LITELLM_API_KEY", "sk-lab");
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
