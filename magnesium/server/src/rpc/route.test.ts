// @effect-diagnostics nodeBuiltinImport:off - reads the test server's state directory.
import * as NodeFSP from "node:fs/promises";

import { MAGNESIUM_WS_METHODS, MAGNESIUM_WS_PATH, RequiredScope } from "@magnesium/contracts";
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { RequestId } from "effect/rpc/RpcMessage";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

import { startTestServer } from "../testing.ts";
import { connect } from "./client.ts";
import { scopeGuard } from "./route.ts";

describe(MAGNESIUM_WS_PATH, () => {
  it.live("answers a signed-in caller over upstream's auth", () =>
    Effect.gen(function* () {
      const server = yield* startTestServer();
      const client = yield* connect(server.wsUrl("reader"));
      const pong = yield* client[MAGNESIUM_WS_METHODS.ping]({});
      expect(pong).toMatchObject({ serverVersion: "0.0.45" });
      expect(Date.parse(pong.now)).toBeGreaterThanOrEqual(Date.parse(pong.startedAt));

      const first = yield* client[MAGNESIUM_WS_METHODS.serverStatus]({}).pipe(
        Stream.take(1),
        Stream.runHead,
      );
      expect(Option.getOrThrow(first)).toMatchObject({
        _tag: "snapshot",
        rows: [{ environmentId: "env-test", label: "cpu-host-1", serverVersion: "0.0.45" }],
      });

      // The server opened its own database beside upstream's.
      const files = yield* Effect.promise(() => NodeFSP.readdir(server.stateDir));
      expect(files).toContain("magnesium.sqlite");
    }),
  );

  it.live(
    "refuses a socket with no session or an unpaired one, and calls it has no scope for",
    () =>
      Effect.gen(function* () {
        const server = yield* startTestServer();
        const anonymous = yield* connect(server.wsUrl());
        const refused = yield* anonymous[MAGNESIUM_WS_METHODS.ping]({}).pipe(
          Effect.timeout("5 seconds"),
          Effect.flip,
        );
        expect(refused._tag).toBe("RpcClientError");

        // Every scope, but minted by the CLI, not a paired device: refused at the upgrade.
        const cli = yield* connect(server.wsUrl("cli"));
        const notPaired = yield* cli[MAGNESIUM_WS_METHODS.ping]({}).pipe(
          Effect.timeout("5 seconds"),
          Effect.flip,
        );
        expect(notPaired._tag).toBe("RpcClientError");

        const scopeless = yield* connect(server.wsUrl("nobody"));
        const forbidden = yield* scopeless[MAGNESIUM_WS_METHODS.ping]({}).pipe(Effect.flip);
        expect(forbidden).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredScope: AuthOrchestrationReadScope,
        });
        const stream = yield* scopeless[MAGNESIUM_WS_METHODS.serverStatus]({}).pipe(
          Stream.runCollect,
          Effect.flip,
        );
        expect(stream._tag).toBe("EnvironmentAuthorizationError");
      }),
  );
});

describe("scope guard", () => {
  const operate = Rpc.make("test.operate", { success: Schema.String }).annotate(
    RequiredScope,
    AuthOrchestrationOperateScope,
  );
  const maintain = Rpc.make("test.maintain", { success: Schema.String }).annotate(
    RequiredScope,
    AuthEnvironmentMaintainScope,
  );
  const unscoped = Rpc.make("test.unscoped", { success: Schema.String });
  const group = RpcGroup.make(operate, maintain, unscoped);
  const rpcOf = (tag: string) => group.requests.get(tag)! as unknown as Rpc.AnyWithProps;
  const ran = "ran" as unknown as RpcMiddleware.SuccessValue;
  const call = (scopes: ReadonlyArray<AuthEnvironmentScope>, tag: string) =>
    scopeGuard(scopes)(Effect.succeed(ran), {
      rpc: rpcOf(tag),
      client: {} as Rpc.ServerClient,
      requestId: RequestId(0),
      payload: {},
      headers: Headers.empty,
    });

  it.effect("keeps a read-only session off an operate RPC", () =>
    Effect.gen(function* () {
      const refused = yield* call([AuthOrchestrationReadScope], "test.operate").pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      const allowed = yield* call(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        "test.operate",
      );
      expect(allowed).toBe(ran);
    }),
  );

  it.effect("lets a grant from before granular permissions do what its broad scopes meant", () =>
    Effect.gen(function* () {
      // A device paired then: the old scopes only, operate among them (T3 Code v0.0.45).
      const legacy = [
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
        AuthAccessWriteScope,
      ] as ReadonlyArray<AuthEnvironmentScope>;
      expect(yield* call(legacy, "test.maintain")).toBe(ran);
      // A granular grant needs the scope itself.
      const granular = yield* call(
        [AuthOrchestrationOperateScope, AuthSettingsWriteScope],
        "test.maintain",
      ).pipe(Effect.flip);
      expect(granular).toMatchObject({ requiredScope: AuthEnvironmentMaintainScope });
    }),
  );

  it.effect("refuses an RPC that names no scope, whoever calls it", () =>
    Effect.gen(function* () {
      const exit = yield* call([AuthOrchestrationOperateScope], "test.unscoped").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});
