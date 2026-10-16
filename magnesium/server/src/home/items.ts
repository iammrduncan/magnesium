import {
  clipHomeText,
  type HomeActivity,
  type HomeAnswer,
  type LocalHomeItem,
} from "@magnesium/contracts";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import {
  ApprovalRequestId,
  type CommandId,
  type MessageId,
  type OrchestrationCommand,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

/**
 * What a server's own thread waits on you for, read from upstream's thread
 * (V1 orchestration), and the commands that answer it. Pure, so the rules are
 * tested here and the service only follows threads.
 */

/** The text the web sends when you approve a plan, so a Home answer reads the same in the thread. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

/** Recent steps shown in Detail. */
const DETAIL_ACTIVITY_LIMIT = 12;

/** Working on a turn or on background work. */
const isBusy = (shell: OrchestrationThreadShell) =>
  shell.session?.status === "running" ||
  shell.session?.status === "starting" ||
  shell.backgroundLiveness === "working";

const isTurnSettled = (shell: OrchestrationThreadShell) =>
  Boolean(shell.latestTurn?.startedAt) &&
  Boolean(shell.latestTurn?.completedAt) &&
  shell.session?.status !== "running";

/** The sidebar's "Plan ready": a plan-mode turn that ended with a plan nobody acted on. */
const isPlanReady = (shell: OrchestrationThreadShell) =>
  !shell.hasPendingUserInput &&
  shell.interactionMode === "plan" &&
  isTurnSettled(shell) &&
  shell.hasActionableProposedPlan;

/** A failure you settled or snoozed has been seen; it stops asking. */
const isSetAside = (shell: OrchestrationThreadShell, now: string) =>
  shell.settledAt !== null ||
  (shell.snoozedUntil !== undefined && shell.snoozedUntil !== null && shell.snoozedUntil > now);

/** Whether the thread's detail is needed: only to read requests and plans. */
export const needsThreadDetail = (shell: OrchestrationThreadShell) =>
  shell.hasPendingApprovals || shell.hasPendingUserInput || isPlanReady(shell);

/** The plan on the latest turn, else the newest one, as the web picks it. */
export const latestPlan = (
  plans: ReadonlyArray<OrchestrationProposedPlan>,
  latestTurnId: string | null | undefined,
): OrchestrationProposedPlan | null => {
  const newest = (candidates: ReadonlyArray<OrchestrationProposedPlan>) =>
    candidates
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1) ?? null;
  const onTurn = latestTurnId ? newest(plans.filter((plan) => plan.turnId === latestTurnId)) : null;
  return onTurn ?? newest(plans);
};

/**
 * One thread's items: each open approval and question, a plan ready to
 * implement, a failure, or that it is working. `detail` may be null when
 * `needsThreadDetail` is false; a thread whose detail is missing shows none
 * of the items that need it.
 */
export const homeItemsOf = (input: {
  readonly shell: OrchestrationThreadShell;
  readonly detail: OrchestrationThread | null;
  readonly projectTitle: string | null;
  readonly now: string;
}): ReadonlyArray<LocalHomeItem> => {
  const { shell, detail, now } = input;
  const base = { threadId: shell.id, title: shell.title, projectTitle: input.projectTitle };
  const items: Array<LocalHomeItem> = [];
  const pending =
    detail !== null && (shell.hasPendingApprovals || shell.hasPendingUserInput)
      ? derivePendingRequests(detail.activities)
      : { approvals: [], userInputs: [] };

  if (shell.hasPendingApprovals) {
    for (const approval of pending.approvals) {
      items.push({
        ...base,
        key: `${shell.id}:approval:${approval.requestId}`,
        since: approval.createdAt,
        body: {
          _tag: "approval",
          requestId: approval.requestId,
          requestKind: approval.requestKind,
          detail: approval.detail === undefined ? null : clipHomeText(approval.detail).text,
          choices: (approval.options ?? []).map((option) => ({
            decision: option.decision,
            label: option.label,
            warning: option.warning ?? null,
          })),
        },
      });
    }
  }

  if (shell.hasPendingUserInput) {
    for (const request of pending.userInputs) {
      items.push({
        ...base,
        key: `${shell.id}:question:${request.requestId}`,
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
              description: option.description ?? null,
              value: option.value ?? null,
            })),
            multiSelect: question.multiSelect === true,
            allowsText: question.allowCustomAnswer !== false || question.options.length === 0,
          })),
        },
      });
    }
  }

  if (detail !== null && isPlanReady(shell)) {
    const plan = latestPlan(detail.proposedPlans, shell.latestTurn?.turnId);
    if (plan !== null && plan.implementedAt === null) {
      const clipped = clipHomeText(plan.planMarkdown);
      items.push({
        ...base,
        key: `${shell.id}:plan:${plan.id}`,
        since: plan.updatedAt,
        body: { _tag: "plan", planId: plan.id, markdown: clipped.text, truncated: clipped.clipped },
      });
    }
  }

  const waiting = shell.hasPendingApprovals || shell.hasPendingUserInput;
  if (isBusy(shell)) {
    if (!waiting) {
      items.push({
        ...base,
        key: `${shell.id}:running`,
        since: shell.latestTurn?.startedAt ?? shell.session?.updatedAt ?? shell.updatedAt,
        body: { _tag: "running" },
      });
    }
  } else if (!waiting && shell.session?.status === "error" && !isSetAside(shell, now)) {
    const message = shell.session.lastError;
    items.push({
      ...base,
      key: `${shell.id}:failure`,
      since: shell.session.updatedAt,
      body: { _tag: "failure", message: message ? clipHomeText(message).text : null },
    });
  }
  return items;
};

/** Ids and the clock, given by the caller so commands are testable. */
export interface CommandContext {
  readonly commandId: () => CommandId;
  readonly messageId: () => MessageId;
  readonly now: string;
}

/**
 * The commands that answer an item in its thread, in order. A plan becomes a
 * new turn in default mode that implements it, as the web does: the mode is
 * set first, since a turn runs in the thread's stored mode.
 */
export const commandsForAnswer = (input: {
  readonly shell: OrchestrationThreadShell;
  readonly answer: HomeAnswer;
  /** The plan's full text, for a plan answer. */
  readonly planMarkdown?: string;
  readonly context: CommandContext;
}): ReadonlyArray<OrchestrationCommand> => {
  const { shell, answer, context } = input;
  switch (answer._tag) {
    case "approval":
      return [
        {
          type: "thread.approval.respond",
          commandId: context.commandId(),
          threadId: shell.id,
          requestId: ApprovalRequestId.make(answer.requestId),
          decision: answer.decision,
          createdAt: context.now,
        },
      ];
    case "question":
      return [
        {
          type: "thread.user-input.respond",
          commandId: context.commandId(),
          threadId: shell.id,
          requestId: ApprovalRequestId.make(answer.requestId),
          answers: answer.answers,
          createdAt: context.now,
        },
      ];
    case "plan":
      return [
        {
          type: "thread.interaction-mode.set",
          commandId: context.commandId(),
          threadId: shell.id,
          interactionMode: "default",
          createdAt: context.now,
        },
        {
          type: "thread.turn.start",
          commandId: context.commandId(),
          threadId: shell.id,
          message: {
            messageId: context.messageId(),
            role: "user",
            text: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${(input.planMarkdown ?? "").trim()}`,
            attachments: [],
          },
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: { threadId: shell.id, planId: answer.planId },
          createdAt: context.now,
        },
      ];
    case "settle":
      return [{ type: "thread.settle", commandId: context.commandId(), threadId: shell.id }];
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

/** The latest turn's finished tool calls, newest last, for Detail. */
export const recentWorkOf = (detail: OrchestrationThread): ReadonlyArray<HomeActivity> => {
  const turnId = detail.latestTurn?.turnId ?? null;
  return detail.activities
    .filter(
      (activity) =>
        (turnId === null || activity.turnId === turnId) &&
        (activity.kind === "tool.completed" || activity.kind === "approval.requested"),
    )
    .slice(-DETAIL_ACTIVITY_LIMIT)
    .map((activity) => {
      const payload =
        activity.payload !== null && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : {};
      return {
        at: activity.createdAt,
        label: activity.summary,
        detail: typeof payload.detail === "string" ? clipHomeText(payload.detail).text : null,
      };
    });
};
