// @effect-diagnostics preferSchemaOverJson:off - the tests measure bytes on the wire as JSON.
import { ServerStatus as ServerStatusRow, ServerStatusItem } from "@magnesium/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerPorts } from "../ports.ts";
import {
  authenticateTestSocket,
  defaultSettingsPorts,
  makeTestThreads,
  testDescriptor,
  testThread,
} from "../testing.ts";
import { deploymentOf, releaseOf } from "./release.ts";
import { countThreads, ServerStatus, layer, threadStateOf } from "./ServerStatus.ts";

const encodeItem = Schema.encodeSync(ServerStatusItem);
const decodeStatus = Schema.decodeUnknownSync(ServerStatusRow);
const wireBytes = (item: ServerStatusItem) =>
  new TextEncoder().encode(JSON.stringify(encodeItem(item))).length;

describe("thread counts", () => {
  it("counts what needs you ahead of what is working, like the sidebar", () => {
    const states = [
      testThread("idle"),
      testThread("working", { run: "running" }),
      testThread("starting", { run: "starting" }),
      testThread("background", { run: "completed", background: "working" }),
      testThread("monitoring", { run: "completed", background: "monitoring" }),
      testThread("approval", { run: "running", approval: true }),
      testThread("question", { run: "running", question: true }),
      // A V2 thread names only its newest open request: here, the approval.
      testThread("both", { approval: true, question: true }),
    ].map(threadStateOf);
    expect(countThreads(states)).toEqual({
      total: 8,
      running: 3,
      waiting: 3,
      approvals: 2,
      questions: 1,
    });
  });
});

describe("server status", () => {
  it.effect("follows the server's threads, re-reading each changed thread once per burst", () =>
    Effect.gen(function* () {
      const threads = yield* makeTestThreads;
      yield* threads.upsert(testThread("a", { run: "running" }));
      const ports = ServerPorts.of({
        baseDir: "/unused",
        stateDir: "/unused",
        authenticate: authenticateTestSocket,
        authenticateWebSocket: authenticateTestSocket,
        environment: Effect.succeed(testDescriptor()),
        threads: threads.ports,
        issueBearerSession: () => Effect.die("unused"),
        getSecret: () => Effect.die("unused"),
        setSecret: () => Effect.die("unused"),
        removeSecret: () => Effect.die("unused"),
        ...defaultSettingsPorts,
      });
      const context = yield* Layer.build(
        layer.pipe(
          Layer.provide(Layer.mergeAll(Layer.succeed(ServerPorts, ports), NodeServices.layer)),
        ),
      );
      const status = Context.get(context, ServerStatus);
      const items = yield* Queue.unbounded<ServerStatusItem>();
      yield* Effect.forkScoped(
        status.subscribe({}).pipe(Stream.runForEach((item) => Queue.offer(items, item))),
      );
      // The first subscriber waits for the threads to be read, so it never sees stale zeros.
      const first = yield* Queue.take(items);
      expect(first._tag).toBe("snapshot");
      expect(first._tag === "snapshot" ? first.rows[0] : null).toMatchObject({
        environmentId: "env-test",
        label: "cpu-host-1",
        serverVersion: "0.0.45",
        threads: { total: 1, running: 1, waiting: 0 },
      });

      yield* threads.upsert(testThread("b", { run: "running", approval: true }));
      yield* threads.upsert(testThread("c", { question: true }));
      yield* threads.remove("a");
      yield* TestClock.adjust("100 millis");
      const changed = yield* Queue.take(items);
      expect(changed._tag).toBe("changes");
      const row = changed._tag === "changes" ? changed.upserts[0]! : null;
      expect(row?.threads).toEqual({
        total: 2,
        running: 0,
        waiting: 2,
        approvals: 1,
        questions: 1,
      });

      // Byte budget: what the hub receives per change, whatever the thread count.
      expect(wireBytes(changed)).toBeLessThan(512);
    }),
  );
});

describe("the release a server runs", () => {
  it("is the release folder its script runs from, and none in development", () => {
    expect(
      releaseOf("/home/agent/.local/share/magnesium/releases/f0d9e1703a/apps/server/dist/bin.mjs"),
    ).toBe("f0d9e1703a");
    // The image keeps the same layout under /opt/magnesium (goal 25).
    expect(releaseOf("/opt/magnesium/releases/742bb8fa1f/apps/server/dist/bin.mjs")).toBe(
      "742bb8fa1f",
    );
    expect(releaseOf("/home/agent/magnesium/apps/server/src/bin.ts")).toBeNull();
  });

  it("says how the server is deployed when MAGNESIUM_DEPLOY names a known way", () => {
    expect(deploymentOf("pod")).toBe("pod");
    expect(deploymentOf(" vm\n")).toBe("vm");
    expect(deploymentOf("bare-metal")).toBe("bare-metal");
    expect(deploymentOf("docker")).toBeNull();
    expect(deploymentOf(undefined)).toBeNull();
  });

  it("is unknown, not an error, from a server that predates it", () => {
    const fromOlderServer = decodeStatus({
      environmentId: "env-test",
      label: "cpu-host-1",
      serverVersion: "0.0.44",
      startedAt: "2026-10-15T00:00:00.000Z",
      threads: { total: 0, running: 0, waiting: 0, approvals: 0, questions: 0 },
    });
    expect(fromOlderServer.release).toBeNull();
    expect(fromOlderServer.deployment).toBeNull();
  });
});
