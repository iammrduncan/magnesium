// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off - the tests lay out release roots on disk and watch what lands there.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MAGNESIUM_WS_METHODS } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { HUB_ATTACHED_FILE } from "../hub/spokeRecords.ts";
import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import {
  authenticateBearer,
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testTicketRoute,
} from "../testing.ts";
import type { UpkeepConfig } from "../upkeep/Upkeep.ts";

const script = NodePath.resolve(import.meta.dirname, "../../../deploy/bin/magnesium-release");

/** A release root holding `releases`, each built, with `current` on the first. */
const releaseRoot = (releases: ReadonlyArray<string>, options: { packed?: boolean } = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-fleet-upkeep-"));
      for (const name of releases) {
        const release = NodePath.join(root, "releases", name);
        NodeFS.mkdirSync(NodePath.join(release, "apps/server/dist"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(release, "apps/server/dist/bin.mjs"), "");
        // An unpacked pack, as on a hub that took its build from a build host.
        if (options.packed) NodeFS.writeFileSync(NodePath.join(release, "RELEASE"), `${name}\n`);
      }
      if (releases[0] !== undefined) {
        NodeFS.symlinkSync(`releases/${releases[0]}`, NodePath.join(root, "current"));
      }
      return root;
    }),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

/** A machine server the hub reaches as `cpu-host-1`, and the hub, with their upkeep set up. */
const hubAndMachine = (machineUpkeep: Partial<UpkeepConfig>, hubUpkeep: Partial<UpkeepConfig>) =>
  Effect.gen(function* () {
    const machine = yield* startTestServer({
      routes: testTicketRoute("machine-token"),
      ports: {
        authenticate: authenticateBearer("machine-token", "operator"),
        environment: Effect.succeed(
          testDescriptor({ environmentId: EnvironmentId.make("env-cpu-host-1") }),
        ),
      },
      upkeep: { script, ...machineUpkeep },
    });
    NodeFS.mkdirSync(NodePath.join(machine.stateDir, "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(machine.stateDir, "userdata/settings.json"), "{}");
    const hub = yield* startTestServer({
      files: {
        [HUB_MACHINES_CONFIG_FILE]: testHubConfig({ "cpu-host-1": machine.origin }),
        [HUB_ATTACHED_FILE]: JSON.stringify({
          attached: [{ name: "gpu-workload", gateway: "gw", url: "http://127.0.0.1:9/spokes/x" }],
        }),
      },
      ports: {
        getSecret: testHubSecrets({ "cpu-host-1": "machine-token" }),
        environment: Effect.succeed(
          testDescriptor({ environmentId: EnvironmentId.make("env-hub"), label: "hub" }),
        ),
      },
      upkeep: { script, ...hubUpkeep },
    });
    const browser = yield* connect(hub.wsUrl("operator"));
    // The hub knows the machine once its link is up.
    yield* browser[MAGNESIUM_WS_METHODS.fleetBackups]({ machine: "cpu-host-1" }).pipe(
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    );
    return { machine, hub, browser };
  });

const waitFor = <A>(read: () => A | undefined) =>
  Effect.suspend(() => {
    const value = read();
    return value === undefined ? Effect.fail("not yet" as const) : Effect.succeed(value);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }));

const pendingOf = (stateDir: string) => {
  try {
    return NodeFS.readFileSync(NodePath.join(stateDir, "upkeep/pending"), "utf8").trim();
  } catch {
    return undefined;
  }
};

describe("Fleet's upkeep through the hub", () => {
  it.live("takes, lists and restores a machine's backups", () =>
    Effect.gen(function* () {
      const stops = yield* Ref.make(0);
      const { machine, browser } = yield* hubAndMachine(
        { launcher: "container", stop: Ref.update(stops, (n) => n + 1) },
        {},
      );
      const made = yield* browser[MAGNESIUM_WS_METHODS.fleetBackupNow]({ machine: "cpu-host-1" });
      expect(NodeFS.existsSync(NodePath.join(machine.stateDir, "backups", made.name))).toBe(true);
      const listed = yield* browser[MAGNESIUM_WS_METHODS.fleetBackups]({ machine: "cpu-host-1" });
      expect(listed).toMatchObject({ keep: 7, backups: [{ name: made.name }] });

      yield* browser[MAGNESIUM_WS_METHODS.fleetRestore]({ machine: "cpu-host-1", name: made.name });
      expect(pendingOf(machine.stateDir)).toBe(`restore ${made.name}`);
      yield* waitFor(() => (Effect.runSync(Ref.get(stops)) === 1 ? true : undefined));
    }),
  );

  it.live("sends the hub's build to a machine like it, which takes it at its next start", () =>
    Effect.gen(function* () {
      const hubRoot = yield* releaseRoot(["abcdef1234"], { packed: true });
      const machineRoot = yield* releaseRoot(["0123456789"]);
      const stops = yield* Ref.make(0);
      const { machine, browser } = yield* hubAndMachine(
        {
          root: machineRoot,
          release: "0123456789",
          launcher: "systemd",
          stop: Ref.update(stops, (n) => n + 1),
        },
        { root: hubRoot, release: "abcdef1234", launcher: "systemd" },
      );
      yield* browser[MAGNESIUM_WS_METHODS.fleetUpdate]({ machine: "cpu-host-1" });
      yield* waitFor(() => pendingOf(machine.stateDir));
      expect(pendingOf(machine.stateDir)).toBe("activate abcdef1234 update");
      expect(
        NodeFS.existsSync(
          NodePath.join(machineRoot, "releases/abcdef1234/apps/server/dist/bin.mjs"),
        ),
      ).toBe(true);
      // The machine's copy of the pack is gone once unpacked.
      expect(NodeFS.readdirSync(NodePath.join(machineRoot, "incoming"))).toEqual([]);
      yield* waitFor(() => (Effect.runSync(Ref.get(stops)) === 1 ? true : undefined));
    }),
  );

  it.live("has a machine on another platform build the hub's commit itself", () =>
    Effect.gen(function* () {
      const machineRoot = yield* releaseRoot(["0123456789"]);
      const stub = NodePath.join(machineRoot, "stub-release");
      NodeFS.writeFileSync(
        stub,
        `printf 'Built abcdef1234. Run: magnesium-release activate abcdef1234\\n'\n`,
      );
      const { machine, browser } = yield* hubAndMachine(
        {
          root: machineRoot,
          release: "0123456789",
          launcher: "systemd",
          platform: "linux-arm64",
          source: "https://example.com/magnesium.git",
          script: stub,
          stop: Effect.void,
        },
        { release: "abcdef1234", platform: "linux-x64" },
      );
      yield* browser[MAGNESIUM_WS_METHODS.fleetUpdate]({ machine: "cpu-host-1" });
      expect(yield* waitFor(() => pendingOf(machine.stateDir))).toBe("activate abcdef1234 update");
    }),
  );

  it.live("says why it won't update the hub itself or a machine its workload owns", () =>
    Effect.gen(function* () {
      const { browser } = yield* hubAndMachine({}, { release: "abcdef1234" });
      const hub = yield* browser[MAGNESIUM_WS_METHODS.fleetUpdate]({ machine: null }).pipe(
        Effect.flip,
      );
      expect(hub).toMatchObject({
        _tag: "UpkeepError",
        detail:
          "Every server follows the hub's build. To put the hub on a new one, deploy it to the hub.",
      });
      const attached = yield* browser[MAGNESIUM_WS_METHODS.fleetUpdate]({
        machine: "gpu-workload",
      }).pipe(Effect.flip);
      expect(attached).toMatchObject({ _tag: "UpkeepError" });
      expect("detail" in attached ? attached.detail : "").toContain(
        "runs inside its workload, whose deploy sets its build",
      );
      const notLaunched = yield* browser[MAGNESIUM_WS_METHODS.fleetUpdate]({
        machine: "cpu-host-1",
      }).pipe(Effect.flip);
      expect("detail" in notLaunched ? notLaunched.detail : "").toBe(
        "Nothing on cpu-host-1 restarts it on another build. Update it with its deploy.",
      );
    }),
  );
});
