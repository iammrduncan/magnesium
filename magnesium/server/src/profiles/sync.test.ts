// @effect-diagnostics nodeBuiltinImport:off - the test lays out a PATH folder on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerPorts } from "../ports.ts";
import { noThreads, noSchedule, testDescriptor } from "../testing.ts";
import { ProfilesConfig } from "./catalog.ts";
import * as ProfileSync from "./ProfileSync.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("profile sync", () => {
  it.effect("picks up a CLI installed after the server started", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-sync-"));
      roots.push(root);
      const bin = NodePath.join(root, "bin");
      NodeFS.mkdirSync(bin);
      // As settings came over from a machine's bare-metal home, before its Codex did.
      const codex = ProviderInstanceId.make("codex");
      const moved: ProviderInstanceConfigMap = {
        [codex]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "MAGNESIUM_SANDBOX", value: "fenced", sensitive: false }],
          config: {
            binaryPath:
              "/home/agent/.local/share/magnesium/current/magnesium/deploy/bin/magnesium-fenced",
          },
        },
      };
      let instances = moved;
      const ports = ServerPorts.of({
        baseDir: root,
        stateDir: root,
        authenticate: () => Effect.die("unused"),
        authenticateWebSocket: () => Effect.die("unused"),
        environment: Effect.succeed(testDescriptor()),
        threads: noThreads,
        schedule: noSchedule,
        issueBearerSession: () => Effect.die("unused"),
        getSecret: () => Effect.succeedNone,
        setSecret: () => Effect.void,
        removeSecret: () => Effect.void,
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: instances,
        })),
        setProviderInstances: (next) => Effect.sync(() => void (instances = next)),
      });
      const config = ProfilesConfig.of({
        folder: NodePath.join(root, "profiles"),
        machine: "cpu-host-2",
        isHub: false,
        env: { PATH: bin },
        setup: {
          stateHome: NodePath.join(root, "state"),
          wrapperDir: "/opt/magnesium-portable/bin",
          binaries: { claude: undefined, codex: undefined, opencode: undefined },
          userHome: NodePath.join(root, "home"),
          fence: { mechanism: "landlock" },
          container: { unavailable: "Agents can't start containers inside a pod." },
          protect: [],
        },
      });
      const sync = yield* ProfileSync.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerPorts, ports),
            Layer.succeed(ProfilesConfig, config),
            NodeServices.layer,
          ),
        ),
      );

      // Not here yet: left as it is.
      yield* sync.syncNow;
      expect(instances[codex]?.config).toMatchObject({
        binaryPath:
          "/home/agent/.local/share/magnesium/current/magnesium/deploy/bin/magnesium-fenced",
      });

      // Codex lands on the PATH while the server runs: the next sync fences it with this install.
      NodeFS.writeFileSync(NodePath.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      yield* sync.syncNow;
      expect(instances[codex]?.config).toMatchObject({
        binaryPath: "/opt/magnesium-portable/bin/magnesium-fenced",
      });
    }),
  );
});
