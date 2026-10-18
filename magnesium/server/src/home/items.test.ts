import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  approvalRequest,
  commandItem,
  proposedPlan,
  questionRequest,
  testThread,
  testThreadRequests,
} from "../testing.ts";
import { viewOf } from "../threads.ts";
import {
  answeredKey,
  commandsForAnswer,
  homeItemsOf,
  latestPlan,
  needsThreadRequests,
  recentWorkOf,
} from "./items.ts";

const NOW = "2026-10-16T02:00:00.000Z";
const at = (iso: string) => DateTime.makeUnsafe(iso);
const PLAN = (id: string) => `1. Snapshot the database\n2. Point the backup at ${id}`;

/** A plan-mode thread whose latest run (`run-2`) ended with a plan nobody acted on. */
const planThread = testThread(
  "backups",
  { run: "completed" },
  {
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    latestRunId: "run-2" as never,
    latestRunCompletedAt: at("2026-10-16T01:05:00.000Z"),
  },
);
const planRequests = testThreadRequests(
  proposedPlan("backups", "old", "run-1", "2026-10-16T00:00:00.000Z", PLAN("old")),
  proposedPlan("backups", "new", "run-2", "2026-10-16T01:05:00.000Z", PLAN("new")),
);

describe("a thread's Home items", () => {
  it("turns each open approval and question into an item, with what the agent asked", () => {
    const view = viewOf(testThread("deploy", { run: "running", approval: true }));
    const done = approvalRequest("deploy", "done", "2026-10-16T01:00:00.000Z", "ls");
    const requests = testThreadRequests(
      {
        ...done,
        runtimeRequests: done.runtimeRequests.map((request) => ({
          ...request,
          status: "resolved" as const,
        })),
      },
      approvalRequest(
        "deploy",
        "apply",
        "2026-10-16T01:10:00.000Z",
        "kubectl apply -f deploy.yaml",
      ),
      questionRequest("deploy", "which", "2026-10-16T01:20:00.000Z"),
    );
    expect(needsThreadRequests(view)).toBe(true);
    const items = homeItemsOf({ view, requests, projectTitle: "infra", now: NOW });
    expect(items.map((item) => item.key)).toEqual([
      "deploy:approval:apply",
      "deploy:question:which",
    ]);
    expect(items[0]).toMatchObject({
      title: "deploy",
      projectTitle: "infra",
      since: "2026-10-16T01:10:00.000Z",
      body: {
        _tag: "approval",
        requestKind: "command",
        detail: "kubectl apply -f deploy.yaml",
        // The provider named no choices: the web's defaults.
        choices: [
          { decision: "cancel", label: "Cancel", warning: null },
          { decision: "decline", label: "Decline", warning: null },
          { decision: "acceptForSession", label: "Always allow this session", warning: null },
          { decision: "accept", label: "Approve", warning: null },
        ],
      },
    });
    expect(items[1]?.body).toMatchObject({
      _tag: "question",
      questions: [
        {
          id: "eval-set",
          question: "Which eval set should the run use?",
          options: [
            { label: "Suite A", description: "Suite A, described.", value: null },
            {
              label: "Needle tests only",
              description: "Needle tests only, described.",
              value: null,
            },
          ],
          multiSelect: false,
          allowsText: true,
        },
      ],
    });
    // A thread waiting on you is not also "working".
    expect(items.some((item) => item.body._tag === "running")).toBe(false);
  });

  it("leaves a request whose session is gone to the thread", () => {
    const view = viewOf(testThread("deploy", { approval: true }));
    const apply = approvalRequest("deploy", "apply", "2026-10-16T01:10:00.000Z");
    const requests = testThreadRequests({
      ...apply,
      runtimeRequests: apply.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: { type: "not_resumable" as const, reason: "The session ended." },
      })),
    });
    expect(homeItemsOf({ view, requests, projectTitle: null, now: NOW })).toEqual([]);
  });

  it("shows a plan only once a plan-mode run has ended with one nobody implemented", () => {
    const items = homeItemsOf({
      view: viewOf(planThread),
      requests: planRequests,
      projectTitle: null,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "backups:plan:new",
      since: "2026-10-16T01:05:00.000Z",
      body: { _tag: "plan", planId: "new", markdown: PLAN("new"), truncated: false },
    });

    // Still running, out of plan mode, or already implemented: no plan card.
    const running = testThread(
      "backups",
      { run: "running" },
      { interactionMode: "plan", hasActionableProposedPlan: true, latestRunId: "run-2" as never },
    );
    expect(
      homeItemsOf({
        view: viewOf(running),
        requests: planRequests,
        projectTitle: null,
        now: NOW,
      }).filter((item) => item.body._tag === "plan"),
    ).toEqual([]);
    expect(
      homeItemsOf({
        view: viewOf({ ...planThread, interactionMode: "default" }),
        requests: planRequests,
        projectTitle: null,
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      homeItemsOf({
        view: viewOf(planThread),
        requests: testThreadRequests(
          proposedPlan("backups", "new", "run-2", "2026-10-16T01:05:00.000Z", "x", "completed"),
        ),
        projectTitle: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("names a failure until you settle it, and what is working", () => {
    const failed = testThread(
      "crawl",
      { run: "failed", lastError: "OpenCode server exited unexpectedly (0)" },
      { latestRunCompletedAt: at("2026-10-16T01:30:00.000Z") },
    );
    expect(
      homeItemsOf({ view: viewOf(failed), requests: null, projectTitle: null, now: NOW }),
    ).toEqual([
      expect.objectContaining({
        key: "crawl:failure",
        since: "2026-10-16T01:30:00.000Z",
        body: { _tag: "failure", message: "OpenCode server exited unexpectedly (0)" },
      }),
    ]);
    const settled = { ...failed, settledAt: at("2026-10-16T01:40:00.000Z") };
    expect(
      homeItemsOf({ view: viewOf(settled), requests: null, projectTitle: null, now: NOW }),
    ).toEqual([]);
    const snoozed = { ...failed, snoozedUntil: at("2026-10-16T03:00:00.000Z") };
    expect(
      homeItemsOf({ view: viewOf(snoozed), requests: null, projectTitle: null, now: NOW }),
    ).toEqual([]);

    const working = testThread(
      "sweep",
      { run: "running" },
      { latestRunStartedAt: at("2026-10-16T01:00:01.000Z") },
    );
    expect(
      homeItemsOf({ view: viewOf(working), requests: null, projectTitle: null, now: NOW }),
    ).toEqual([
      expect.objectContaining({
        key: "sweep:running",
        since: "2026-10-16T01:00:01.000Z",
        body: { _tag: "running" },
      }),
    ]);
  });

  it("counts work the agent left to wake it, but not a dev server left running", () => {
    const items = (background: "working" | "monitoring") =>
      homeItemsOf({
        view: viewOf(testThread("serve", { run: "completed", background })),
        requests: null,
        projectTitle: null,
        now: NOW,
      }).map((item) => item.body._tag);
    expect(items("working")).toEqual(["running"]);
    expect(items("monitoring")).toEqual([]);
  });

  it("shows only what a subagent asks; its parent is the one working", () => {
    const child = testThread(
      "child",
      { run: "running", approval: true },
      {
        lineage: {
          parentThreadId: "parent" as never,
          relationshipToParent: "subagent",
          rootThreadId: "parent" as never,
        },
      },
    );
    const items = homeItemsOf({
      view: viewOf(child),
      requests: testThreadRequests(approvalRequest("child", "r1", "2026-10-16T01:00:00.000Z")),
      projectTitle: null,
      now: NOW,
    });
    expect(items.map((item) => item.body._tag)).toEqual(["approval"]);
    expect(
      homeItemsOf({
        view: viewOf({ ...child, pendingRuntimeRequest: null }),
        requests: null,
        projectTitle: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("picks the latest run's plan, else the newest", () => {
    const requests = testThreadRequests(
      proposedPlan("t", "a", "run-1", "2026-10-16T00:00:00.000Z", "a"),
      proposedPlan("t", "b", "run-2", "2026-10-16T00:10:00.000Z", "b"),
      proposedPlan("t", "c", "run-1", "2026-10-16T00:20:00.000Z", "c"),
    );
    expect(latestPlan(requests, "run-2")?.id).toBe("b");
    expect(latestPlan(requests, "run-9")?.id).toBe("c");
    expect(latestPlan(testThreadRequests(), "run-1")).toBeNull();
  });

  it("lists the run's finished work for Detail", () => {
    expect(
      recentWorkOf([
        commandItem("t", "c1", "run-1", "2026-10-16T01:00:00.000Z", "vp test run"),
        commandItem("t", "c2", "run-1", "2026-10-16T01:01:00.000Z", "git status"),
      ]),
    ).toEqual([
      { at: "2026-10-16T01:00:00.000Z", label: "Ran command", detail: "vp test run" },
      { at: "2026-10-16T01:01:00.000Z", label: "Ran command", detail: "git status" },
    ]);
  });
});

describe("answering from Home", () => {
  const view = viewOf(testThread("deploy", { run: "completed" }));
  let next = 0;
  const context = {
    commandId: () => CommandId.make(`command-${(next += 1)}`),
    messageId: () => MessageId.make("message-1"),
  };

  it("sends the command the web's own controls send, for each kind", () => {
    expect(
      commandsForAnswer({
        view,
        answer: { _tag: "approval", requestId: "apply", decision: "accept" },
        context,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "runtime-request.respond",
        threadId: "deploy",
        requestId: RuntimeRequestId.make("apply"),
        decision: "accept",
      }),
    ]);
    expect(
      commandsForAnswer({
        view,
        answer: { _tag: "question", requestId: "which", answers: { "eval-set": "Suite A" } },
        context,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "runtime-request.respond",
        requestId: "which",
        answers: { "eval-set": "Suite A" },
      }),
    ]);
    expect(
      commandsForAnswer({ view, answer: { _tag: "settle" }, context }).map(
        (command) => command.type,
      ),
    ).toEqual(["thread.settle"]);
  });

  it("implements a plan as the web does: default mode first, then a run that names the plan", () => {
    const commands = commandsForAnswer({
      view: viewOf(planThread),
      answer: { _tag: "plan", planId: "new" },
      planMarkdown: "  1. Snapshot\n2. Restore  ",
      context,
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "message.dispatch",
    ]);
    expect(commands[0]).toMatchObject({ interactionMode: "default" });
    expect(commands[1]).toMatchObject({
      text: "PLEASE IMPLEMENT THIS PLAN:\n1. Snapshot\n2. Restore",
      attachments: [],
      sourcePlanRef: { threadId: "backups", planId: "new" },
      dispatchMode: { type: "start_immediately" },
    });
    // Already in default mode: only the run.
    expect(
      commandsForAnswer({
        view,
        answer: { _tag: "plan", planId: "new" },
        planMarkdown: "1. Snapshot",
        context,
      }).map((command) => command.type),
    ).toEqual(["message.dispatch"]);
  });

  it("knows which item an answer settles", () => {
    expect(answeredKey("t", { _tag: "approval", requestId: "r", decision: "decline" })).toBe(
      "t:approval:r",
    );
    expect(answeredKey("t", { _tag: "plan", planId: "p" })).toBe("t:plan:p");
    expect(answeredKey("t", { _tag: "settle" })).toBe("t:failure");
  });
});
