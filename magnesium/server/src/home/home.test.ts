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
  approvalActivity,
  makeTestThreads,
  questionActivity,
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testThread,
  testThreadDetail,
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

describe("magnesium.home.* on the hub", () => {
  it.live(
    "gathers every server's needs, answers one on its machine, and holds an offline machine's",
    () =>
      Effect.gen(function* () {
        const machineThreads = yield* makeTestThreads;
        yield* machineThreads.upsert(
          testThread("deploy", { session: "running", approval: true }),
          testThreadDetail("deploy", {
            activities: [approvalActivity("apply", "2026-10-16T01:00:00.000Z", "kubectl apply")],
          }),
        );
        const hubThreads = yield* makeTestThreads;
        yield* hubThreads.upsert(
          testThread("notes", { question: true }),
          testThreadDetail("notes", {
            activities: [questionActivity("which", "2026-10-16T01:10:00.000Z")],
          }),
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
            type: "thread.approval.respond",
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
