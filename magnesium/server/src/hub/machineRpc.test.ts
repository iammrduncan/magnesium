// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - fixtures stand in for a hub, its clock and its config.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MAGNESIUM_WS_METHODS } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { ServerPorts } from "../ports.ts";
import {
  authenticateTestSocket,
  noThreads,
  startTestServer,
  TEST_ENVIRONMENT_ID,
  testDescriptor,
} from "../testing.ts";
import * as HubMachines from "./HubMachines.ts";
import { connectMachine } from "./machineRpc.ts";

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

/** A hub that carries one machine, `cpu-host-1`, holding `token` for it. */
const hubFor = (machineOrigin: string, token: string) =>
  Effect.gen(function* () {
    const baseDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-hub-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(baseDir, HubMachines.HUB_MACHINES_CONFIG_FILE),
        JSON.stringify({ machines: [{ name: "cpu-host-1", url: machineOrigin }] }),
      ),
    );
    const stored = JSON.stringify({
      token,
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
    });
    return HubMachines.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ServerPorts, ports),
          FetchHttpClient.layer,
          NodeServices.layer,
        ),
      ),
    );
  });

describe("the hub dialing a machine", () => {
  it.live("opens the machine's route with a ticket its own token bought", () =>
    Effect.gen(function* () {
      const machine = yield* startTestServer({ routes: ticketRoute });
      const hub = yield* hubFor(machine.origin, "machine-token");
      const client = yield* connectMachine("cpu-host-1").pipe(Effect.provide(hub));
      expect(yield* client[MAGNESIUM_WS_METHODS.ping]({})).toMatchObject({
        serverVersion: "0.0.45",
      });
      const status = yield* client[MAGNESIUM_WS_METHODS.serverStatus]({}).pipe(
        Stream.take(1),
        Stream.runHead,
      );
      expect(Option.getOrThrow(status)._tag).toBe("snapshot");
    }),
  );

  it.live("fails, and says so, when the machine refuses the hub's token", () =>
    Effect.gen(function* () {
      const machine = yield* startTestServer({ routes: ticketRoute });
      const hub = yield* hubFor(machine.origin, "revoked-token");
      const error = yield* connectMachine("cpu-host-1").pipe(Effect.provide(hub), Effect.flip);
      expect(error).toMatchObject({ _tag: "MachineRequestError", rejected: true });
    }),
  );
});
