import {
  clipHomeText,
  type HomeActivity,
  type HomeAnswer,
  type LocalHomeItem,
} from "@magnesium/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  type CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2TurnItem,
  PlanId,
  type ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadRequestRecords } from "../ports.ts";
import { isBusy, isSubagent, type ThreadView } from "../threads.ts";

/**
 * What a server's own thread waits on you for, read from upstream's thread
 * (Orchestrator V2), and the commands that answer it. Pure, so the rules are
 * tested here and the service only follows threads.
 */

/** The text the web sends when you approve a plan, so a Home answer reads the same in the thread. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

/** Recent steps shown in Detail. */
const DETAIL_ACTIVITY_LIMIT = 12;

/** The choices the web offers when a provider names none. */
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
];

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** The latest run ended and nothing runs in its place (the web's `isLatestRunSettled`). */
const isLatestRunSettled = (view: ThreadView) =>
  view.latestRun !== null &&
  !ACTIVE_RUN_STATUSES.has(view.latestRun.status) &&
  view.runtime?.activeRunId !== view.latestRun.runId;

/** The sidebar's "Plan ready": a plan-mode run that ended with a plan nobody acted on. */
const isPlanReady = (view: ThreadView) =>
  !view.hasPendingUserInput &&
  view.interactionMode === "plan" &&
  isLatestRunSettled(view) &&
  view.hasActionableProposedPlan;

/** A failure you settled or snoozed has been seen; it stops asking. */
const isSetAside = (view: ThreadView, now: string) =>
  view.settledAt !== null || (view.snoozedUntil !== null && view.snoozedUntil > now);

/** Whether the thread's requests are needed: only to read what it asks and its plans. */
export const needsThreadRequests = (view: ThreadView) =>
  view.hasPendingApprovals || view.hasPendingUserInput || isPlanReady(view);

type ProposedPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "proposed_plan" }>;

/** The plan's own turn item, which carries its time and, in a paged read, its text. */
const planItemOf = (records: ThreadRequestRecords, planId: PlanId) =>
  records.turnItems.findLast(
    (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "proposed_plan" }> =>
      item.type === "proposed_plan" && item.planId === planId,
  );

const planTime = (records: ThreadRequestRecords, plan: ProposedPlan) => {
  const item = planItemOf(records, plan.id);
  return item === undefined ? "" : DateTime.formatIso(item.updatedAt);
};

/** The plan on the latest run, else the newest one, as the web picks it. */
export const latestPlan = (
  records: ThreadRequestRecords,
  latestRunId: string | null,
): ProposedPlan | null => {
  const plans = records.plans.filter((plan): plan is ProposedPlan => plan.kind === "proposed_plan");
  const onRun = latestRunId === null ? [] : plans.filter((plan) => plan.runId === latestRunId);
  return (
    (onRun.length > 0 ? onRun : plans)
      .toSorted(
        (left, right) =>
          planTime(records, left).localeCompare(planTime(records, right)) ||
          left.id.localeCompare(right.id),
      )
      .at(-1) ?? null
  );
};

/** A plan's full text: on the plan, or on its turn item when the plan was paged. */
export const planMarkdownOf = (records: ThreadRequestRecords, plan: ProposedPlan) =>
  plan.markdown || (planItemOf(records, plan.id)?.markdown ?? "");

/**
 * One thread's items: each open approval and question, a plan ready to
 * implement, a failure, or that it is working. `requests` may be null when
 * `needsThreadRequests` is false; a thread whose requests are missing shows
 * none of the items that need them. A subagent's thread shows only what it
 * asks: its parent is the one working or failing.
 */
export const homeItemsOf = (input: {
  readonly view: ThreadView;
  readonly requests: ThreadRequestRecords | null;
  readonly projectTitle: string | null;
  readonly now: string;
}): ReadonlyArray<LocalHomeItem> => {
  const { view, requests, now } = input;
  const base = { threadId: view.id, title: view.title, projectTitle: input.projectTitle };
  const items: Array<LocalHomeItem> = [];
  const pending =
    requests !== null && (view.hasPendingApprovals || view.hasPendingUserInput)
      ? derivePendingThreadRequests(requests)
      : { approvals: [], userInputs: [] };

  // A request that can no longer be answered (its session is gone) is left to the thread.
  for (const approval of pending.approvals) {
    if (approval.responseCapability !== "live") continue;
    items.push({
      ...base,
      key: `${view.id}:approval:${approval.requestId}`,
      since: approval.createdAt,
      body: {
        _tag: "approval",
        requestId: approval.requestId,
        requestKind: approval.requestKind,
        detail: approval.detail === undefined ? null : clipHomeText(approval.detail).text,
        choices: (approval.options ?? DEFAULT_APPROVAL_OPTIONS).map((option) => ({
          decision: option.decision,
          label: option.label,
          warning: option.warning ?? null,
        })),
      },
    });
  }

  for (const request of pending.userInputs) {
    if (request.responseCapability === "not_resumable") continue;
    items.push({
      ...base,
      key: `${view.id}:question:${request.requestId}`,
      since: request.createdAt,
      body: {
        _tag: "question",
        requestId: request.requestId,
        questions: request.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description || null,
            value: option.value ?? null,
          })),
          multiSelect: question.multiSelect,
          allowsText: question.allowCustomAnswer !== false || question.options.length === 0,
        })),
      },
    });
  }

  if (requests !== null && isPlanReady(view)) {
    const plan = latestPlan(requests, view.latestRun?.runId ?? null);
    if (plan !== null && plan.status === "active") {
      const clipped = clipHomeText(planMarkdownOf(requests, plan));
      items.push({
        ...base,
        key: `${view.id}:plan:${plan.id}`,
        since: planTime(requests, plan) || view.updatedAt,
        body: { _tag: "plan", planId: plan.id, markdown: clipped.text, truncated: clipped.clipped },
      });
    }
  }

  if (isSubagent(view)) return items;
  const waiting = view.hasPendingApprovals || view.hasPendingUserInput;
  if (isBusy(view)) {
    if (!waiting) {
      items.push({
        ...base,
        key: `${view.id}:running`,
        since:
          view.runtime?.activityStartedAt ??
          view.latestRun?.startedAt ??
          view.runtime?.updatedAt ??
          view.updatedAt,
        body: { _tag: "running" },
      });
    }
  } else if (!waiting && view.runtime?.status === "failed" && !isSetAside(view, now)) {
    const message = view.runtime.lastError;
    items.push({
      ...base,
      key: `${view.id}:failure`,
      since: view.latestRun?.completedAt ?? view.runtime.updatedAt,
      body: { _tag: "failure", message: message ? clipHomeText(message).text : null },
    });
  }
  return items;
};

/** Ids, given by the caller so commands are testable. */
export interface CommandContext {
  readonly commandId: () => CommandId;
  readonly messageId: () => MessageId;
}

/**
 * The commands that answer an item in its thread, in order. A plan becomes a
 * new run in default mode that implements it, as the web does: the mode is set
 * first, since a run takes the thread's stored mode.
 */
export const commandsForAnswer = (input: {
  readonly view: ThreadView;
  readonly answer: HomeAnswer;
  /** The plan's full text, for a plan answer. */
  readonly planMarkdown?: string;
  readonly context: CommandContext;
}): ReadonlyArray<OrchestrationV2Command> => {
  const { view, answer, context } = input;
  switch (answer._tag) {
    case "approval":
      return [
        {
          type: "runtime-request.respond",
          commandId: context.commandId(),
          threadId: view.id,
          requestId: RuntimeRequestId.make(answer.requestId),
          decision: answer.decision,
        },
      ];
    case "question":
      return [
        {
          type: "runtime-request.respond",
          commandId: context.commandId(),
          threadId: view.id,
          requestId: RuntimeRequestId.make(answer.requestId),
          answers: answer.answers,
        },
      ];
    case "plan": {
      const setMode: ReadonlyArray<OrchestrationV2Command> =
        view.interactionMode === "default"
          ? []
          : [
              {
                type: "thread.interaction-mode.set",
                commandId: context.commandId(),
                threadId: view.id,
                interactionMode: "default",
              },
            ];
      return [
        ...setMode,
        {
          type: "message.dispatch",
          commandId: context.commandId(),
          createdBy: "user",
          creationSource: "web",
          threadId: view.id,
          messageId: context.messageId(),
          text: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${(input.planMarkdown ?? "").trim()}`,
          attachments: [],
          sourcePlanRef: { threadId: view.id, planId: PlanId.make(answer.planId) },
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        },
      ];
    }
    case "settle":
      return [{ type: "thread.settle", commandId: context.commandId(), threadId: view.id }];
  }
};

/** The key of the item an answer is for, to check it is still open before sending. */
export const answeredKey = (threadId: string, answer: HomeAnswer): string => {
  switch (answer._tag) {
    case "approval":
      return `${threadId}:approval:${answer.requestId}`;
    case "question":
      return `${threadId}:question:${answer.requestId}`;
    case "plan":
      return `${threadId}:plan:${answer.planId}`;
    case "settle":
      return `${threadId}:failure`;
  }
};

/** The turn item types Detail lists, as the thread's work log names them. */
export const RECENT_WORK_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "approval_request",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

const workOf = (item: OrchestrationV2TurnItem): { label: string; detail: string | null } | null => {
  switch (item.type) {
    case "command_execution":
      return { label: item.title ?? "Ran command", detail: item.input };
    case "file_change":
      return { label: item.title ?? `Changed ${item.fileName}`, detail: null };
    case "file_search":
      return { label: item.title ?? "Searched files", detail: item.pattern ?? null };
    case "web_search":
      return { label: item.title ?? "Searched the web", detail: item.patterns?.join(", ") ?? null };
    case "dynamic_tool":
      return { label: item.title ?? item.toolName ?? "Used a tool", detail: null };
    case "approval_request":
      return { label: "Approval requested", detail: item.prompt ?? item.requestKind };
    default:
      return null;
  }
};

/** The latest run's finished tool calls and approvals, newest last, for Detail. */
export const recentWorkOf = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<HomeActivity> =>
  items
    .flatMap((item) => {
      const work = workOf(item);
      return work === null
        ? []
        : [
            {
              at: DateTime.formatIso(item.completedAt ?? item.updatedAt),
              label: work.label,
              detail: work.detail === null ? null : clipHomeText(work.detail).text,
            },
          ];
    })
    .slice(-DETAIL_ACTIVITY_LIMIT);
