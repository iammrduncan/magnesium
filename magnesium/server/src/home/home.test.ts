// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - the test times what the browser sees and measures its bytes as JSON.
import {
  type HomeItem,
  homeItemKey,
  HomeItemsItem,
  type HomeSummary,
  type LiveTableItem,
  type LocalHomeItem,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import {
  approvalRequest,
  makeTestSchedule,
  makeTestThreads,
  questionRequest,
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testScheduledTask,
  testThread,
  testThreadRequests,
  testTicketRoute,
} from "../testing.ts";
import { buildHome } from "./Home.ts";

const localItem = (key: string, body: LocalHomeItem["body"], since: string): LocalHomeItem =>
  ({
    key,
    threadId: key.split(":")[0]!,
    title: key.split(":")[0]!,
    projectTitle: "infra",
    since,
    body,
  }) as LocalHomeItem;

const approval = (requestId: string): LocalHomeItem["body"] => ({
  _tag: "approval",
  requestId,
  requestKind: "command",
  detail: "kubectl apply -f deploy/serving.yaml -n inference",
  choices: [],
});

describe("building Home", () => {
  it("counts what the hub can see, and keeps an offline machine's needs without counting them", () => {
    const built = buildHome({
      sources: [
        {
          name: null,
          label: "hub",
          environmentId: EnvironmentId.make("env-hub"),
          reachable: true,
          items: [
            localItem("notes:approval:a", approval("a"), "2026-10-16T01:00:00.000Z"),
            localItem("crawl:running", { _tag: "running" }, "2026-10-16T01:05:00.000Z"),
          ],
        },
        {
          name: "gpu-host-2",
          label: "gpu-host-2",
          environmentId: EnvironmentId.make("env-gpu-host-2"),
          reachable: false,
          items: [
            localItem(
              "eval:failure",
              { _tag: "failure", message: null },
              "2026-10-16T00:00:00.000Z",
            ),
            localItem("sweep:running", { _tag: "running" }, "2026-10-16T00:30:00.000Z"),
          ],
        },
      ],
      pins: new Map([["gpu-host-2/eval:failure", "2026-10-16T02:00:00.000Z"]]),
    });
    expect(built.items.map(homeItemKey)).toEqual([
      "@self/notes:approval:a",
      "@self/crawl:running",
      // Its needs stay on Home; a claim that it is working does not.
      "gpu-host-2/eval:failure",
    ]);
    expect(built.items[2]).toMatchObject({
      machine: { name: "gpu-host-2", label: "gpu-host-2" },
      reachable: false,
      pinnedAt: "2026-10-16T02:00:00.000Z",
    });
    expect(built.summary).toEqual({
      key: "home",
      counts: { approval: 1, question: 0, plan: 0, failure: 0, total: 1, running: 1 },
      unseen: ["gpu-host-2"],
    });
  });
});

/** A browser's copy of a live table on the hub, kept from its stream. */
const watchTable = <Row, E>(
  stream: Stream.Stream<LiveTableItem<Row>, E>,
  key: (row: Row) => string,
) =>
  Effect.gen(function* () {
    const rows = new Map<string, Row>();
    const changed = yield* Queue.unbounded<void>();
    yield* Effect.forkScoped(
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (item._tag === "snapshot") rows.clear();
            for (const row of item._tag === "snapshot" ? item.rows : item.upserts) {
              rows.set(key(row), row);
            }
            if (item._tag === "changes") for (const removed of item.removals) rows.delete(removed);
          }).pipe(Effect.andThen(Queue.offer(changed, undefined))),
        ),
      ),
    );
    /** Waits for the rows to satisfy `check`, as the stream delivers them. */
    const until = (check: () => boolean) =>
      Effect.gen(function* () {
        while (!check()) yield* Queue.take(changed);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.die(new Error(`Never got there: ${JSON.stringify([...rows.values()])}`)),
        }),
      );
    return { rows, until };
  });

const APPROVAL_KEY = "cpu-host-1/deploy:approval:apply";
const QUESTION_KEY = "@self/notes:question:which";

describe("building Home with scheduled runs", () => {
  it("counts a run that could not start, never next runs, and drops an offline machine's", () => {
    const scheduled = (taskId: string): LocalHomeItem["body"] => ({
      _tag: "scheduled",
      taskId,
      lastRun: "succeeded",
    });
    const built = buildHome({
      sources: [
        {
          name: null,
          label: "hub",
          environmentId: null,
          reachable: true,
          items: [
            localItem("schedule:a:next", scheduled("a"), "2026-10-16T14:00:00.000Z"),
            localItem(
              "schedule:b:failure",
              { _tag: "scheduled-failure", taskId: "b", message: null },
              "2026-10-16T02:00:00.000Z",
            ),
          ],
        },
        {
          name: "gpu-host-1" as never,
          label: "gpu-host-1",
          environmentId: null,
          reachable: false,
          items: [localItem("schedule:c:next", scheduled("c"), "2026-10-16T15:00:00.000Z")],
        },
      ],
      pins: new Map(),
    });
    expect(built.items.map((item) => item.key)).toEqual([
      "@self/schedule:a:next",
      "@self/schedule:b:failure",
    ]);
    expect(built.summary.counts).toMatchObject({ failure: 1, total: 1, running: 0 });
  });
});

describe("magnesium.home.* on the hub", () => {
  it.live(
    "gathers every server's needs, answers one on its machine, and holds an offline machine's",
    () =>
      Effect.gen(function* () {
        const machineThreads = yield* makeTestThreads;
        yield* machineThreads.upsert(
          testThread("deploy", { run: "running", approval: true }),
          testThreadRequests(
            approvalRequest("deploy", "apply", "2026-10-16T01:00:00.000Z", "kubectl apply"),
          ),
        );
        const hubThreads = yield* makeTestThreads;
        yield* hubThreads.upsert(
          testThread("notes", { question: true }),
          testThreadRequests(questionRequest("notes", "which", "2026-10-16T01:10:00.000Z")),
        );

        const machineRun = yield* Scope.make();
        const cpu = yield* startTestServer({
          routes: testTicketRoute("machine-token"),
          ports: {
            threads: machineThreads.ports,
            environment: Effect.succeed(
              testDescriptor({ environmentId: EnvironmentId.make("env-cpu-host-1") }),
            ),
          },
        }).pipe(Scope.provide(machineRun));
        const hub = yield* startTestServer({
          files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({ "cpu-host-1": cpu.origin }) },
          ports: {
            threads: hubThreads.ports,
            getSecret: testHubSecrets({ "cpu-host-1": "machine-token" }),
            environment: Effect.succeed(
              testDescriptor({ environmentId: EnvironmentId.make("env-hub"), label: "hub" }),
            ),
          },
        });

        const browser = yield* connect(hub.wsUrl("operator"));
        const needs = yield* watchTable(browser[MAGNESIUM_WS_METHODS.homeNeeds]({}), homeItemKey);
        const summary = yield* watchTable(
          browser[MAGNESIUM_WS_METHODS.homeSummary]({}),
          (row: HomeSummary) => row.key,
        );
        const appeared = Date.now();
        yield* needs.until(() => needs.rows.has(APPROVAL_KEY) && needs.rows.has(QUESTION_KEY));
        // A new approval reaches Home within two seconds (goal 06, Test it 8).
        expect(Date.now() - appeared).toBeLessThan(2_000);
        // Fleet names the machine's environment once its status arrives, a moment later.
        yield* needs.until(() => needs.rows.get(APPROVAL_KEY)?.machine.environmentId !== null);
        expect(needs.rows.get(APPROVAL_KEY)).toMatchObject({
          title: "deploy",
          machine: { name: "cpu-host-1", environmentId: "env-cpu-host-1" },
          reachable: true,
          pinnedAt: null,
          body: { _tag: "approval", requestId: "apply", detail: "kubectl apply" },
        });
        yield* summary.until(() => summary.rows.get("home")?.counts.total === 2);
        expect(summary.rows.get("home")).toMatchObject({
          counts: { approval: 1, question: 1, total: 2 },
          unseen: [],
        });

        // The answer goes to the thread on its own machine, as that thread's own command.
        yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: APPROVAL_KEY,
          answer: { _tag: "approval", requestId: "apply", decision: "accept" },
        });
        expect(machineThreads.dispatched).toEqual([
          expect.objectContaining({
            type: "runtime-request.respond",
            threadId: "deploy",
            requestId: "apply",
            decision: "accept",
          }),
        ]);
        expect(hubThreads.dispatched).toEqual([]);

        // An answer to a request the thread no longer has is refused, not sent.
        const stale = yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: QUESTION_KEY,
          answer: { _tag: "question", requestId: "elsewhere", answers: { "eval-set": "Suite A" } },
        }).pipe(Effect.flip);
        expect(stale).toMatchObject({ _tag: "HomeAnswerError" });
        expect(hubThreads.dispatched).toEqual([]);

        // A pin moves with the item and outlives the browser that set it.
        yield* browser[MAGNESIUM_WS_METHODS.homePin]({ key: QUESTION_KEY, pinned: true });
        yield* needs.until(() => needs.rows.get(QUESTION_KEY)?.pinnedAt !== null);

        // The machine stops: its card stays, can't be answered, and isn't counted.
        yield* Scope.close(machineRun, Exit.void);
        yield* needs.until(() => needs.rows.get(APPROVAL_KEY)?.reachable === false);
        yield* summary.until(() => summary.rows.get("home")?.unseen[0] === "cpu-host-1");
        expect(summary.rows.get("home")?.counts.total).toBe(1);
        const offline = yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: APPROVAL_KEY,
          answer: { _tag: "approval", requestId: "apply", decision: "decline" },
        }).pipe(Effect.flip);
        expect(offline).toMatchObject({
          _tag: "HomeAnswerError",
          detail: "cpu-host-1 is offline. Answer it when it's back.",
        });

        // Reading Home is read scope; answering it is operate.
        const reader = yield* connect(hub.wsUrl("reader"));
        const refused = yield* reader[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: QUESTION_KEY,
          answer: { _tag: "question", requestId: "which", answers: { "eval-set": "Suite A" } },
        }).pipe(Effect.flip);
        expect(refused._tag).toBe("EnvironmentAuthorizationError");
      }),
  );
});

const encodeItem = Schema.encodeSync(HomeItemsItem);
const wireBytes = (item: LiveTableItem<HomeItem>) =>
  new TextEncoder().encode(JSON.stringify(encodeItem(item))).length;

const boardItem = (key: string, body: HomeItem["body"]): HomeItem =>
  ({
    key: `gpu-host-2/${key}`,
    threadId: key.split(":")[0]!,
    title: "Draft the serving deployment",
    projectTitle: "infra",
    since: "2026-10-16T01:00:00.000Z",
    body,
    machine: { name: "gpu-host-2", label: "gpu-host-2", environmentId: "env-gpu-host-2" },
    reachable: true,
    pinnedAt: null,
  }) as HomeItem;

describe("scheduled runs on Home (goal 24)", () => {
  const FAILED_KEY = "@self/schedule:nightly:failure";
  const NEXT_KEY = "@self/schedule:crawl:next";
  const nightly = testScheduledTask("nightly", {
    title: "Nightly dream cycle",
    nextRunAt: "2026-10-17T02:00:00.000Z" as never,
    lastRunAt: "2026-10-16T02:00:00.000Z" as never,
    lastRunStatus: "failed",
    lastRunError: "The project's folder is gone.",
  });

  it.live("shows next runs and a run that could not start, and retries it from its card", () =>
    Effect.gen(function* () {
      const schedule = yield* makeTestSchedule;
      yield* schedule.set([
        nightly,
        testScheduledTask("crawl", {
          title: "Repo crawl and mirror",
          nextRunAt: "2026-10-16T14:00:00.000Z" as never,
          lastRunStatus: "succeeded",
        }),
        testScheduledTask("paused", { enabled: false }),
      ]);
      const hub = yield* startTestServer({
        files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({}) },
        ports: { schedule: schedule.ports },
      });
      const browser = yield* connect(hub.wsUrl("operator"));
      const needs = yield* watchTable(browser[MAGNESIUM_WS_METHODS.homeNeeds]({}), homeItemKey);
      const summary = yield* watchTable(
        browser[MAGNESIUM_WS_METHODS.homeSummary]({}),
        (row: HomeSummary) => row.key,
      );
      yield* needs.until(() => needs.rows.has(FAILED_KEY) && needs.rows.has(NEXT_KEY));
      expect(needs.rows.get(FAILED_KEY)).toMatchObject({
        threadId: null,
        title: "Nightly dream cycle",
        since: "2026-10-16T02:00:00.000Z",
        body: {
          _tag: "scheduled-failure",
          taskId: "nightly",
          message: "The project's folder is gone.",
        },
      });
      expect(needs.rows.get(NEXT_KEY)).toMatchObject({
        since: "2026-10-16T14:00:00.000Z",
        body: { _tag: "scheduled", taskId: "crawl", lastRun: "succeeded" },
      });
      // A disabled task has no next run.
      expect([...needs.rows.keys()].some((key) => key.includes("paused"))).toBe(false);
      // The failed run needs you; next runs don't count.
      yield* summary.until(() => summary.rows.get("home")?.counts.failure === 1);
      expect(summary.rows.get("home")?.counts).toMatchObject({ failure: 1, total: 1, running: 0 });

      yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
        key: FAILED_KEY,
        answer: { _tag: "retry", taskId: "nightly" },
      });
      expect(schedule.ran).toEqual(["nightly"]);

      // The run started, so the card goes, and a second Retry is refused.
      yield* schedule.set([{ ...nightly, lastRunStatus: "running" }]);
      yield* needs.until(() => !needs.rows.has(FAILED_KEY));
      const again = yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
        key: FAILED_KEY,
        answer: { _tag: "retry", taskId: "nightly" },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(again)).toBe(true);
      expect(schedule.ran).toEqual(["nightly"]);
    }).pipe(Effect.scoped),
  );

  it.live("retries a scheduled task from its failed run's thread, and settles that thread", () =>
    Effect.gen(function* () {
      const DIGEST_KEY = "@self/digest-1:failure";
      const MANUAL_KEY = "@self/manual:failure";
      const schedule = yield* makeTestSchedule;
      yield* schedule.set([
        testScheduledTask("digest", { title: "Morning digest", lastRunStatus: "succeeded" }),
      ]);
      // The run started, so the scheduler counts it a success; it failed in its thread.
      const threads = yield* makeTestThreads;
      yield* threads.startedByTask("digest-1", "digest-1-run", "digest");
      yield* threads.upsert(
        testThread("digest-1", { run: "failed", lastError: "git worktree add failed" }),
      );
      yield* threads.upsert(testThread("manual", { run: "failed", lastError: "Provider exited" }));
      const hub = yield* startTestServer({
        files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({}) },
        ports: { threads: threads.ports, schedule: schedule.ports },
      });
      const browser = yield* connect(hub.wsUrl("operator"));
      const needs = yield* watchTable(browser[MAGNESIUM_WS_METHODS.homeNeeds]({}), homeItemKey);
      yield* needs.until(() => needs.rows.has(DIGEST_KEY) && needs.rows.has(MANUAL_KEY));
      expect(needs.rows.get(DIGEST_KEY)?.body).toEqual({
        _tag: "failure",
        message: "git worktree add failed",
        taskId: "digest",
      });
      // A run no task started has nothing to retry.
      expect(needs.rows.get(MANUAL_KEY)?.body).toEqual({
        _tag: "failure",
        message: "Provider exited",
      });

      const wrong = yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
        key: MANUAL_KEY,
        answer: { _tag: "retry", taskId: "digest" },
      }).pipe(Effect.flip);
      expect(wrong).toMatchObject({ _tag: "HomeAnswerError" });
      expect(schedule.ran).toEqual([]);

      yield* browser[MAGNESIUM_WS_METHODS.homeAnswer]({
        key: DIGEST_KEY,
        answer: { _tag: "retry", taskId: "digest" },
      });
      expect(schedule.ran).toEqual(["digest"]);
      expect(threads.dispatched).toEqual([
        expect.objectContaining({ type: "thread.settle", threadId: "digest-1" }),
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("Home's byte budget", () => {
  it("opens the board's four cards in under 4 KiB, and sends one new approval in under 640 bytes", () => {
    const rows = [
      boardItem("serving:approval:a", approval("a")),
      boardItem("research:question:q", {
        _tag: "question",
        requestId: "q",
        questions: [
          {
            id: "eval-set",
            header: "Eval set",
            question: "Which eval set should the long-context run use?",
            options: [
              {
                label: "Long-context suite A",
                description: "Recommended. Covers 8k to 128k.",
                value: null,
              },
              { label: "Needle tests only", description: "Fast, about 20 minutes.", value: null },
              { label: "Both, smaller samples", description: "About 1 hour.", value: null },
            ],
            multiSelect: false,
            allowsText: true,
          },
        ],
      }),
      boardItem("ops:plan:p", {
        _tag: "plan",
        planId: "p",
        markdown:
          "1. Snapshot the KB database and verify the checksum\n2. Point the backup job at the new pool\n3. Run one restore test, then retire the old target",
        truncated: false,
      }),
      boardItem("scribe:failure", {
        _tag: "failure",
        message: "Exit 1 after 4m 12s. The embedder timed out on 3 of 3 retries.",
      }),
    ];
    const opened = wireBytes({ _tag: "snapshot", sequence: 1_760_000_000_000, rows });
    const change = wireBytes({
      _tag: "changes",
      sequence: 1_760_000_000_001,
      upserts: [rows[0]!],
      removals: [],
    });
    expect(opened).toBeLessThan(4 * 1024);
    expect(change).toBeLessThan(640);
  });
});
