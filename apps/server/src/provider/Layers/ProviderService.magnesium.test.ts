// magnesium: a thread switching between level twins that share provider state (goal 03)
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { ProviderAdapterProcessError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const FENCED = ProviderInstanceId.make("codex");
const NATIVE = ProviderInstanceId.make("mg_native_codex");

/**
 * Two instances of one driver over one provider home, like a fenced instance and
 * its native twin. Like Codex's thread writer lock, a provider thread can be open
 * in one process at a time: a start that resumes it while the other instance
 * still has it open fails.
 */
function makeTwins(driver: ProviderDriverKind) {
  const writers = new Map<string, ProviderInstanceId>();
  const log: string[] = [];
  const failNextStart = new Set<ProviderInstanceId>();

  const makeAdapter = (instanceId: ProviderInstanceId) => {
    const sessions = new Map<ThreadId, ProviderSession>();
    const unsupported = () => Effect.die(new Error("not used in these tests"));
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: driver,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input: ProviderSessionStartInput) =>
        Effect.gen(function* () {
          log.push(`start ${instanceId}`);
          const providerThread = String(input.threadId);
          const writer = writers.get(providerThread);
          if (failNextStart.delete(instanceId)) {
            return yield* new ProviderAdapterProcessError({
              provider: driver,
              threadId: input.threadId,
              detail: "the CLI could not start",
            });
          }
          if (writer !== undefined && writer !== instanceId) {
            return yield* new ProviderAdapterProcessError({
              provider: driver,
              threadId: input.threadId,
              detail: `thread ${providerThread} already has an active writer`,
            });
          }
          writers.set(providerThread, instanceId);
          const session: ProviderSession = {
            provider: driver,
            providerInstanceId: instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            // A start with no cursor opens a new provider thread.
            resumeCursor: input.resumeCursor ?? { opaque: `${instanceId}-new-${providerThread}` },
            createdAt: "2026-10-15T00:00:00.000Z",
            updatedAt: "2026-10-15T00:00:00.000Z",
          };
          sessions.set(input.threadId, session);
          return session;
        }),
      sendTurn: (input) =>
        Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("turn-1") }),
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession: (threadId) =>
        Effect.sync(() => {
          log.push(`stop ${instanceId}`);
          sessions.delete(threadId);
          if (writers.get(String(threadId)) === instanceId) writers.delete(String(threadId));
        }),
      listSessions: () => Effect.sync(() => Array.from(sessions.values())),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: unsupported,
      rollbackThread: unsupported,
      stopAll: () => Effect.sync(() => sessions.clear()),
      streamEvents: Stream.empty,
    };
    return adapter;
  };

  const adapters = new Map([
    [FENCED, makeAdapter(FENCED)],
    [NATIVE, makeAdapter(NATIVE)],
  ]);
  const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
    getByInstance: (instanceId) => Effect.succeed(adapters.get(instanceId)!),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: { driverKind: driver, continuationKey: `${driver}:home:shared` },
      }),
    listInstances: () => Effect.succeed([FENCED, NATIVE]),
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
  const layer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
    Layer.provide(
      ProviderSessionDirectoryLive.pipe(
        Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
      ),
    ),
    // The fenced instance says so, as sync writes it; its native twin does too.
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        providerInstances: {
          [FENCED]: {
            driver,
            environment: [{ name: "MAGNESIUM_SANDBOX", value: "fenced", sensitive: false }],
          },
          [NATIVE]: {
            driver,
            environment: [{ name: "MAGNESIUM_SANDBOX", value: "native", sensitive: false }],
          },
        },
      }),
    ),
    // A state home of its own, which a test can put folders in.
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "mg-provider-twins-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { writers, log, failNextStart, adapters, layer };
}

/** What the provider command reactor does when a thread's instance changes: resume on the new one. */
const switchTo = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService.ProviderService;
    const current = (yield* provider.listSessions()).find(
      (session) => session.threadId === threadId,
    );
    return yield* provider.startSession(threadId, {
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "approval-required",
      ...(current?.resumeCursor !== undefined ? { resumeCursor: current.resumeCursor } : {}),
    });
  });

describe("switching a thread between level twins", () => {
  for (const driver of [ProviderDriverKind.make("codex"), ProviderDriverKind.make("claudeAgent")]) {
    it.effect(`${driver}: fenced, native, fenced again, one process at a time`, () => {
      const twins = makeTwins(driver);
      return Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = ThreadId.make("thread-twins");
        const first = yield* switchTo(threadId, FENCED);

        const native = yield* switchTo(threadId, NATIVE);
        assert.equal(native.providerInstanceId, NATIVE);
        assert.deepEqual(native.resumeCursor, first.resumeCursor);

        const back = yield* switchTo(threadId, FENCED);
        assert.equal(back.providerInstanceId, FENCED);
        assert.deepEqual(back.resumeCursor, first.resumeCursor);

        // Each instance let go of the thread before the next one opened it.
        assert.deepEqual(twins.log, [
          `start ${FENCED}`,
          `stop ${FENCED}`,
          `start ${NATIVE}`,
          `stop ${NATIVE}`,
          `start ${FENCED}`,
        ]);
        assert.deepEqual(
          (yield* provider.listSessions()).map((session) => session.providerInstanceId),
          [FENCED],
        );
      }).pipe(Effect.provide(twins.layer));
    });
  }

  it.effect("a switch with no session left, as after a restart, still resumes the thread", () => {
    const twins = makeTwins(ProviderDriverKind.make("codex"));
    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("thread-after-restart");
      const first = yield* switchTo(threadId, FENCED);
      // A restart ends every session and keeps the thread's binding.
      yield* twins.adapters.get(FENCED)!.stopSession(threadId);
      assert.deepEqual(yield* provider.listSessions(), []);

      const native = yield* switchTo(threadId, NATIVE);
      assert.equal(native.providerInstanceId, NATIVE);
      assert.deepEqual(native.resumeCursor, first.resumeCursor);
    }).pipe(Effect.provide(twins.layer));
  });

  it.effect("a switch that fails to start leaves the thread to resume where it was", () => {
    const twins = makeTwins(ProviderDriverKind.make("codex"));
    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = ThreadId.make("thread-failed-switch");
      const first = yield* switchTo(threadId, FENCED);

      twins.failNextStart.add(NATIVE);
      const failure = yield* Effect.flip(switchTo(threadId, NATIVE));
      assert.include(String(failure), "the CLI could not start");

      // The previous instance resumes the thread from its saved state.
      const resumed = yield* provider.startSession(threadId, {
        threadId,
        providerInstanceId: FENCED,
        runtimeMode: "approval-required",
      });
      assert.equal(resumed.providerInstanceId, FENCED);
      assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
    }).pipe(Effect.provide(twins.layer));
  });

  it.effect(
    "starts no agent in a folder of the state home outside its workspaces, and says why",
    () => {
      const twins = makeTwins(ProviderDriverKind.make("codex"));
      return Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const fs = yield* FileSystem.FileSystem;
        const { baseDir } = yield* ServerConfig.ServerConfig;
        const threadId = ThreadId.make("thread-in-the-state-home");
        const backup = `${baseDir}/backups/2026-10-15`;
        const project = `${baseDir}/projects/mg-scratch`;
        yield* fs.makeDirectory(backup, { recursive: true });
        yield* fs.makeDirectory(project, { recursive: true });

        const start = (cwd: string) =>
          provider.startSession(threadId, {
            threadId,
            providerInstanceId: FENCED,
            runtimeMode: "approval-required",
            cwd,
          });
        for (const cwd of [backup, baseDir, `${baseDir}/userdata`]) {
          const failure = yield* Effect.flip(start(cwd));
          assert.include(
            failure.message,
            "agents may work only in projects/, worktrees/ and scratch/",
          );
        }
        assert.deepEqual(twins.log, [], "no agent started");

        const started = yield* start(project);
        assert.equal(started.providerInstanceId, FENCED);
        // Native is unfenced by choice: it may run anywhere.
        const native = yield* provider.startSession(ThreadId.make("thread-native-in-backups"), {
          threadId: ThreadId.make("thread-native-in-backups"),
          providerInstanceId: NATIVE,
          runtimeMode: "approval-required",
          cwd: backup,
        });
        assert.equal(native.providerInstanceId, NATIVE);
      }).pipe(Effect.provide(twins.layer));
    },
  );
});
