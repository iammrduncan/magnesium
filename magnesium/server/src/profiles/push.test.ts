// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalFetchInEffect:off preferSchemaOverJson:off - fixtures stand in for a hub, a machine and their folders.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENTS_API_PATH,
  AGENTS_MCP_PATH,
  MAGNESIUM_WS_METHODS,
  profileInstanceId,
} from "@magnesium/contracts";
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as HubMachines from "../hub/HubMachines.ts";
import { connectMachine } from "../hub/machineRpc.ts";
import { ServerPorts } from "../ports.ts";
import {
  authenticateTestSocket,
  defaultSettingsPorts,
  noThreads,
  startTestServer,
  TEST_ENVIRONMENT_ID,
  testDescriptor,
} from "../testing.ts";
import { InstanceSource, ProfilesConfig } from "./catalog.ts";
import * as HubProfilePusher from "./HubProfilePusher.ts";

const SCRATCH_A = {
  "profile.yaml": "name: scratch-a\nmachines: [cpu-host-1]\n",
  "AGENTS.md": "You help with scratch work.\n",
  "CLAUDE.md": "End every reply with the word `ok-a`.\n",
};

/** Upstream's ticket route on the machine: the hub's token buys a ticket for a standard session. */
const ticketRoute = HttpRouter.add(
  "POST",
  "/api/auth/websocket-ticket",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== "Bearer machine-token") {
      return HttpServerResponse.jsonUnsafe({ error: "nope" }, { status: 401 });
    }
    return HttpServerResponse.jsonUnsafe({
      ticket: "operator",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }),
);

/** A machine whose provider-instance writes the test can read back. */
const startMachine = Effect.gen(function* () {
  let instances: ProviderInstanceConfigMap = {};
  const machine = yield* startTestServer({
    routes: ticketRoute,
    ports: {
      getSettings: Effect.map(defaultSettingsPorts.getSettings, (settings) => ({
        ...settings,
        providerInstances: instances,
      })),
      setProviderInstances: (next) => Effect.sync(() => void (instances = next)),
    },
  });
  return { ...machine, instances: () => instances };
});

/** A hub holding the owner's profiles, carrying one machine, `cpu-host-1`. */
const hubFor = (machineOrigin: string) =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-hub-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const folder = NodePath.join(baseDir, "profiles");
    for (const [file, content] of Object.entries(SCRATCH_A)) {
      NodeFS.mkdirSync(NodePath.join(folder, "scratch-a"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(folder, "scratch-a", file), content);
    }
    NodeFS.writeFileSync(
      NodePath.join(baseDir, HubMachines.HUB_MACHINES_CONFIG_FILE),
      JSON.stringify({ machines: [{ name: "cpu-host-1", url: machineOrigin }] }),
    );
    const stored = JSON.stringify({
      token: "machine-token",
      environmentId: TEST_ENVIRONMENT_ID,
      label: "cpu-host-1",
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const ports = ServerPorts.of({
      baseDir,
      stateDir: baseDir,
      authenticate: authenticateTestSocket,
      authenticateWebSocket: authenticateTestSocket,
      environment: Effect.succeed(testDescriptor({ label: "hub" })),
      threads: noThreads,
      issueBearerSession: () => Effect.die("unused"),
      getSecret: (name) =>
        Effect.succeed(
          name === "magnesium-hub-machine-cpu-host-1"
            ? Option.some(new TextEncoder().encode(stored))
            : Option.none(),
        ),
      setSecret: () => Effect.void,
      removeSecret: () => Effect.void,
      ...defaultSettingsPorts,
    });
    const config = ProfilesConfig.of({
      folder,
      machine: "hub",
      isHub: true,
      setup: {
        stateHome: baseDir,
        wrapperDir: undefined,
        binaries: { claude: undefined, codex: undefined, opencode: undefined },
        userHome: baseDir,
        fence: { unavailable: "test" },
        container: { unavailable: "test" },
        protect: [],
      },
    });
    const services = Layer.mergeAll(
      Layer.succeed(ServerPorts, ports),
      Layer.succeed(ProfilesConfig, config),
      Layer.succeed(InstanceSource, InstanceSource.of({ instances: Effect.succeed({}) })),
      FetchHttpClient.layer,
      NodeServices.layer,
    );
    return HubProfilePusher.layer.pipe(
      Layer.provideMerge(HubMachines.layer),
      Layer.provideMerge(services),
    );
  });

describe("the hub's push", () => {
  it.live("reaches the machine, which syncs it into provider instances at once", () =>
    Effect.gen(function* () {
      const previous = process.env.MAGNESIUM_CLAUDE_BIN;
      process.env.MAGNESIUM_CLAUDE_BIN = "/bin/sh";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.MAGNESIUM_CLAUDE_BIN;
          else process.env.MAGNESIUM_CLAUDE_BIN = previous;
        }),
      );
      const machine = yield* startMachine;
      const hub = yield* hubFor(machine.origin);
      const status = yield* Effect.gen(function* () {
        const pusher = yield* HubProfilePusher.HubProfilePusher;
        yield* pusher.pushNow;
        return yield* pusher.status;
      }).pipe(Effect.provide(hub));
      expect(status).toMatchObject([{ machine: "cpu-host-1", error: null, refused: [] }]);
      expect(Object.keys(machine.instances())).toContain(
        profileInstanceId("claude", "fenced", "scratch-a"),
      );

      // The machine reports the revision it holds, so the next tick pushes nothing.
      const client = yield* connectMachine("cpu-host-1").pipe(Effect.provide(hub));
      expect((yield* client[MAGNESIUM_WS_METHODS.profileRevision]({})).revision).toBe(
        status[0]?.revision,
      );
      const listed = yield* client[MAGNESIUM_WS_METHODS.listProfiles]({});
      expect(listed.profiles.map((profile) => [profile.name, profile.runsHere])).toEqual([
        ["scratch-a", true],
      ]);

      // The same operation over REST and MCP, for agents and tools.
      const rest = yield* Effect.promise(() =>
        fetch(`${machine.origin}${AGENTS_API_PATH}/profiles`, {
          headers: { cookie: "t3_session=reader" },
        }).then((response) => response.json() as Promise<{ profiles: Array<{ name: string }> }>),
      );
      expect(rest.profiles.map((profile) => profile.name)).toEqual(["scratch-a"]);
      const mcp = yield* Effect.promise(() =>
        fetch(`${machine.origin}${AGENTS_MCP_PATH}`, {
          method: "POST",
          headers: { cookie: "t3_session=reader", "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_profiles", arguments: {} },
          }),
        }).then(
          (response) =>
            response.json() as Promise<{
              result: { structuredContent: { profiles: Array<{ name: string }> } };
            }>,
        ),
      );
      expect(mcp.result.structuredContent.profiles.map((profile) => profile.name)).toEqual([
        "scratch-a",
      ]);
    }),
  );

  it.live("answers nobody who has not signed in", () =>
    Effect.gen(function* () {
      const machine = yield* startMachine;
      const tools = yield* Effect.promise(() =>
        fetch(`${machine.origin}${AGENTS_MCP_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
      expect(tools.status).toBe(401);
    }),
  );
});
