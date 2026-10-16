import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { approvalActivity, questionActivity, testThread, testThreadDetail } from "../testing.ts";
import {
  answeredKey,
  commandsForAnswer,
  homeItemsOf,
  latestPlan,
  needsThreadDetail,
} from "./items.ts";

const NOW = "2026-10-16T02:00:00.000Z";

const plan = (
  id: string,
  turnId: string,
  updatedAt: string,
  implementedAt: string | null = null,
): OrchestrationProposedPlan =>
  ({
    id,
    turnId,
    planMarkdown: `1. Snapshot the database\n2. Point the backup at ${id}`,
    implementedAt,
    implementationThreadId: null,
    createdAt: updatedAt,
    updatedAt,
  }) as unknown as OrchestrationProposedPlan;

const settledPlanTurn = {
  turnId: "turn-2",
  state: "completed",
  requestedAt: "2026-10-16T01:00:00.000Z",
  startedAt: "2026-10-16T01:00:01.000Z",
  completedAt: "2026-10-16T01:05:00.000Z",
  assistantMessageId: null,
} as const;

const resolved = (requestId: string, at: string) =>
  ({
    id: `resolved-${requestId}`,
    tone: "approval",
    kind: "approval.resolved",
    summary: "Approval resolved",
    payload: { requestId, decision: "accept" },
    turnId: null,
    createdAt: at,
  }) as unknown as OrchestrationThreadActivity;

describe("a thread's Home items", () => {
  it("turns each open approval and question into an item, with what the agent asked", () => {
    const shell = testThread("deploy", { session: "running", approval: true, question: true });
    const detail = testThreadDetail("deploy", {
      activities: [
        approvalActivity("done", "2026-10-16T01:00:00.000Z", "ls"),
        resolved("done", "2026-10-16T01:00:05.000Z"),
        approvalActivity("apply", "2026-10-16T01:10:00.000Z", "kubectl apply -f deploy.yaml"),
        questionActivity("which", "2026-10-16T01:20:00.000Z"),
      ],
    });
    expect(needsThreadDetail(shell)).toBe(true);
    const items = homeItemsOf({ shell, detail, projectTitle: "infra", now: NOW });
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
        choices: [],
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

  it("shows a plan only once a plan-mode turn has ended with one nobody implemented", () => {
    const shell = testThread("backups", { session: "ready" }, {
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: settledPlanTurn,
    } as never);
    const detail = testThreadDetail("backups", {
      proposedPlans: [
        plan("old", "turn-1", "2026-10-16T00:00:00.000Z"),
        plan("new", "turn-2", "2026-10-16T01:05:00.000Z"),
      ],
    });
    const items = homeItemsOf({ shell, detail, projectTitle: null, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "backups:plan:new",
      since: "2026-10-16T01:05:00.000Z",
      body: { _tag: "plan", planId: "new", truncated: false },
    });

    // Still running, or out of plan mode: not ready yet.
    const running = { ...settledPlanTurn, completedAt: null };
    expect(
      homeItemsOf({
        shell: { ...shell, latestTurn: running } as never,
        detail,
        projectTitle: null,
        now: NOW,
      }).filter((item) => item.body._tag === "plan"),
    ).toEqual([]);
    expect(
      homeItemsOf({
        shell: { ...shell, interactionMode: "default" } as never,
        detail,
        projectTitle: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("names a failure until you settle it, and what is working", () => {
    const failed = testThread("crawl", { session: "error" }, {
      session: {
        threadId: "crawl",
        status: "error",
        activeTurnId: null,
        lastError: "OpenCode server exited unexpectedly (0)",
        updatedAt: "2026-10-16T01:30:00.000Z",
      },
    } as never);
    expect(homeItemsOf({ shell: failed, detail: null, projectTitle: null, now: NOW })).toEqual([
      expect.objectContaining({
        key: "crawl:failure",
        since: "2026-10-16T01:30:00.000Z",
        body: { _tag: "failure", message: "OpenCode server exited unexpectedly (0)" },
      }),
    ]);
    const settled = { ...failed, settledAt: "2026-10-16T01:40:00.000Z" } as never;
    expect(homeItemsOf({ shell: settled, detail: null, projectTitle: null, now: NOW })).toEqual([]);

    const working = testThread("sweep", { session: "running" }, {
      latestTurn: { ...settledPlanTurn, completedAt: null },
    } as never);
    expect(homeItemsOf({ shell: working, detail: null, projectTitle: null, now: NOW })).toEqual([
      expect.objectContaining({
        key: "sweep:running",
        since: settledPlanTurn.startedAt,
        body: { _tag: "running" },
      }),
    ]);
  });

  it("picks the latest turn's plan, else the newest", () => {
    const plans = [
      plan("a", "turn-1", "2026-10-16T00:00:00.000Z"),
      plan("b", "turn-2", "2026-10-16T00:10:00.000Z"),
      plan("c", "turn-1", "2026-10-16T00:20:00.000Z"),
    ];
    expect(latestPlan(plans, "turn-2")?.id).toBe("b");
    expect(latestPlan(plans, "turn-9")?.id).toBe("c");
    expect(latestPlan([], "turn-1")).toBeNull();
  });
});

describe("answering from Home", () => {
  const shell = testThread("deploy", { session: "ready" });
  let next = 0;
  const context = {
    commandId: () => CommandId.make(`command-${(next += 1)}`),
    messageId: () => MessageId.make("message-1"),
    now: NOW,
  };

  it("sends the command the web's own controls send, for each kind", () => {
    expect(
      commandsForAnswer({
        shell,
        answer: { _tag: "approval", requestId: "apply", decision: "accept" },
        context,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "thread.approval.respond",
        threadId: "deploy",
        requestId: "apply",
        decision: "accept",
      }),
    ]);
    expect(
      commandsForAnswer({
        shell,
        answer: { _tag: "question", requestId: "which", answers: { "eval-set": "Suite A" } },
        context,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "thread.user-input.respond",
        requestId: "which",
        answers: { "eval-set": "Suite A" },
      }),
    ]);
    expect(
      commandsForAnswer({ shell, answer: { _tag: "settle" }, context }).map(
        (command) => command.type,
      ),
    ).toEqual(["thread.settle"]);
  });

  it("implements a plan as the web does: default mode first, then a turn that names the plan", () => {
    const commands = commandsForAnswer({
      shell,
      answer: { _tag: "plan", planId: "new" },
      planMarkdown: "  1. Snapshot\n2. Restore  ",
      context,
    });
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "thread.turn.start",
    ]);
    expect(commands[0]).toMatchObject({ interactionMode: "default" });
    expect(commands[1]).toMatchObject({
      message: { text: "PLEASE IMPLEMENT THIS PLAN:\n1. Snapshot\n2. Restore", attachments: [] },
      interactionMode: "default",
      runtimeMode: "approval-required",
      sourceProposedPlan: { threadId: "deploy", planId: "new" },
    });
  });

  it("knows which item an answer settles", () => {
    expect(answeredKey("t", { _tag: "approval", requestId: "r", decision: "decline" })).toBe(
      "t:approval:r",
    );
    expect(answeredKey("t", { _tag: "plan", planId: "p" })).toBe("t:plan:p");
    expect(answeredKey("t", { _tag: "settle" })).toBe("t:failure");
  });
});
