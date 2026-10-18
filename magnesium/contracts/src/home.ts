import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { HubMachineName } from "./hub.ts";

/**
 * Home (goal 06): what needs you on every server, answered where you see it.
 * Each server reports its own threads on `magnesium.needs.local`: what each
 * one waits on you for, and which are working. The hub gathers every server's
 * into `magnesium.home.needs`, adds the machine and your pins, and counts them
 * on `magnesium.home.summary`. Answers go back the same way, to the thread on
 * its own machine.
 */

/** What an item is, in Home's order (D18): kind first, then the longest wait. */
export const HOME_NEED_KINDS = ["approval", "question", "plan", "failure"] as const;
export type HomeNeedKind = (typeof HOME_NEED_KINDS)[number];

/** Long texts are cut to this on the wire; Open shows the whole thread. */
export const HOME_TEXT_LIMIT = 4_000;

export const ApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const ApprovalChoice = Schema.Struct({
  decision: ApprovalDecision,
  label: Schema.String,
  warning: Schema.NullOr(Schema.String),
});
export type ApprovalChoice = typeof ApprovalChoice.Type;

/** The agent asks to run a command, read or change files, or use a tool. */
export const HomeApproval = Schema.TaggedStruct("approval", {
  requestId: Schema.String,
  /** `command`, `file-read`, `file-change`, `mcp-elicitation` or `permission`. */
  requestKind: Schema.String,
  /** What it wants to do, as the provider put it: a command, a reason. */
  detail: Schema.NullOr(Schema.String),
  /** The provider's own choices; empty means the standard ones. */
  choices: Schema.Array(ApprovalChoice),
});
export type HomeApproval = typeof HomeApproval.Type;

export const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** What answering with this option sends; the label when null. */
  value: Schema.NullOr(Schema.String),
});
export type QuestionOption = typeof QuestionOption.Type;

export const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean,
  /** A free-text answer is allowed besides the options (always, when there are none). */
  allowsText: Schema.Boolean,
});
export type Question = typeof Question.Type;

/** The agent asks you one or more questions. */
export const HomeQuestion = Schema.TaggedStruct("question", {
  requestId: Schema.String,
  questions: Schema.Array(Question),
});
export type HomeQuestion = typeof HomeQuestion.Type;

/** A plan-mode turn finished with a plan to implement. */
export const HomePlan = Schema.TaggedStruct("plan", {
  planId: Schema.String,
  markdown: Schema.String,
  /** The plan was longer than `HOME_TEXT_LIMIT`. */
  truncated: Schema.Boolean,
});
export type HomePlan = typeof HomePlan.Type;

/** The thread's last turn failed. */
export const HomeFailure = Schema.TaggedStruct("failure", {
  message: Schema.NullOr(Schema.String),
});
export type HomeFailure = typeof HomeFailure.Type;

/**
 * A scheduled task's last run could not start (goal 24): its thread was never
 * made, or its message never sent. Retry runs it now; the task's page has the
 * rest. A run that started and failed is a failed thread instead.
 */
export const HomeScheduledFailure = Schema.TaggedStruct("scheduled-failure", {
  taskId: Schema.String,
  message: Schema.NullOr(Schema.String),
});
export type HomeScheduledFailure = typeof HomeScheduledFailure.Type;

/** Not a need: the thread is working right now ("Running now"). */
export const HomeRunning = Schema.TaggedStruct("running", {});
export type HomeRunning = typeof HomeRunning.Type;

/** Not a need: a scheduled task's next run ("Next scheduled runs"); the item's `since` is when. */
export const HomeScheduled = Schema.TaggedStruct("scheduled", {
  taskId: Schema.String,
  /** How the task's last run went. */
  lastRun: Schema.Literals(["never", "running", "succeeded", "failed"]),
});
export type HomeScheduled = typeof HomeScheduled.Type;

export const HomeItemBody = Schema.Union([
  HomeApproval,
  HomeQuestion,
  HomePlan,
  HomeFailure,
  HomeScheduledFailure,
  HomeRunning,
  HomeScheduled,
]);
export type HomeItemBody = typeof HomeItemBody.Type;

/** One item from one server's own threads. */
export const LocalHomeItem = Schema.Struct({
  /** Unique on its server: the thread (or scheduled task), the kind, and the request or plan. */
  key: Schema.String,
  /** None for a scheduled task that starts a new thread each run. */
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  /** When it started waiting on you, or started working; when it runs, for a scheduled run. */
  since: IsoDateTime,
  body: HomeItemBody,
});
export type LocalHomeItem = typeof LocalHomeItem.Type;

export const localHomeItemKey = (item: Pick<LocalHomeItem, "key">) => item.key;

export const HomeMachine = Schema.Struct({
  /** The machine's name on the hub; null for the hub's own threads. */
  name: Schema.NullOr(HubMachineName),
  label: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
});
export type HomeMachine = typeof HomeMachine.Type;

/** An item on the hub's Home, from any server. */
export const HomeItem = Schema.Struct({
  ...LocalHomeItem.fields,
  /** `<machine>/<server's key>`, the machine being `@self` for the hub's own. */
  key: Schema.String,
  machine: HomeMachine,
  /** False while the hub can't reach its machine: it is shown, but can't be answered. */
  reachable: Schema.Boolean,
  /** Pinned items come first, newest pin first (D18). */
  pinnedAt: Schema.NullOr(IsoDateTime),
});
export type HomeItem = typeof HomeItem.Type;

export const homeItemKey = (item: Pick<HomeItem, "key">) => item.key;

/** The hub's key for a server's item. */
export const toHomeKey = (machineName: string | null, localKey: string) =>
  `${machineName ?? "@self"}/${localKey}`;

export const HomeCounts = Schema.Struct({
  approval: NonNegativeInt,
  question: NonNegativeInt,
  plan: NonNegativeInt,
  failure: NonNegativeInt,
  /** Every need: the four kinds together. */
  total: NonNegativeInt,
  running: NonNegativeInt,
});
export type HomeCounts = typeof HomeCounts.Type;

/** Home's header and the footer's Needs you, as a one-row table keyed `home`. */
export const HomeSummary = Schema.Struct({
  key: Schema.Literal("home"),
  counts: HomeCounts,
  /** Machines whose items the hub can't see right now, by label: not counted, never zero. */
  unseen: Schema.Array(Schema.String),
});
export type HomeSummary = typeof HomeSummary.Type;

export const homeSummaryKey = (summary: Pick<HomeSummary, "key">) => summary.key;

/** An answer to one item, sent to the thread on its own machine. */
export const HomeAnswer = Schema.Union([
  Schema.TaggedStruct("approval", { requestId: Schema.String, decision: ApprovalDecision }),
  Schema.TaggedStruct("question", {
    requestId: Schema.String,
    /** Keyed by question id: the option's value (or label), the typed text, or several for multi-select. */
    answers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ),
  }),
  /** Implement the plan in its own thread. */
  Schema.TaggedStruct("plan", { planId: Schema.String }),
  /** Done with a failure: settle its thread, as the sidebar does. Unsettle brings it back. */
  Schema.TaggedStruct("settle", {}),
  /** Run a scheduled task now, after its last run could not start. */
  Schema.TaggedStruct("retry", { taskId: Schema.String }),
]);
export type HomeAnswer = typeof HomeAnswer.Type;

export const LocalAnswerInput = Schema.Struct({
  /** None for an answer to a scheduled task. */
  threadId: Schema.NullOr(ThreadId),
  answer: HomeAnswer,
});
export type LocalAnswerInput = typeof LocalAnswerInput.Type;

export const HomeAnswerInput = Schema.Struct({ key: Schema.String, answer: HomeAnswer });
export type HomeAnswerInput = typeof HomeAnswerInput.Type;

export const HomePinInput = Schema.Struct({ key: Schema.String, pinned: Schema.Boolean });
export type HomePinInput = typeof HomePinInput.Type;

/** Why an answer did not go through, in a sentence for the card. */
export class HomeAnswerError extends Schema.TaggedError<HomeAnswerError>()("HomeAnswerError", {
  detail: Schema.String,
}) {}

/** One recent step of a thread's work, for Detail: a tool call and what it printed. */
export const HomeActivity = Schema.Struct({
  at: IsoDateTime,
  label: Schema.String,
  /** Output or details, cut to `HOME_TEXT_LIMIT`. */
  detail: Schema.NullOr(Schema.String),
});
export type HomeActivity = typeof HomeActivity.Type;

/** A thread's latest work, fetched only when Detail opens a card. */
export const HomeDetail = Schema.Struct({ activities: Schema.Array(HomeActivity) });
export type HomeDetail = typeof HomeDetail.Type;

export const LocalDetailInput = Schema.Struct({ threadId: ThreadId });
export const HomeDetailInput = Schema.Struct({ key: Schema.String });

/** Home's order (D18): pins first (newest pin first), then kind, then the longest wait. */
export const compareHomeNeeds = (left: HomeItem, right: HomeItem): number => {
  if (left.pinnedAt !== right.pinnedAt) {
    if (left.pinnedAt === null) return 1;
    if (right.pinnedAt === null) return -1;
    return right.pinnedAt.localeCompare(left.pinnedAt);
  }
  const kind = (item: HomeItem) => {
    const need = homeNeedKind(item.body);
    return need === null ? HOME_NEED_KINDS.length : HOME_NEED_KINDS.indexOf(need);
  };
  return (
    kind(left) - kind(right) ||
    left.since.localeCompare(right.since) ||
    left.key.localeCompare(right.key)
  );
};

/** The kind of need an item is, for Home's order and counts; null for what isn't a need. */
export const homeNeedKind = (body: HomeItemBody): HomeNeedKind | null => {
  switch (body._tag) {
    case "running":
    case "scheduled":
      return null;
    case "scheduled-failure":
      return "failure";
    default:
      return body._tag;
  }
};

export const isHomeNeed = (item: Pick<HomeItem, "body">) => homeNeedKind(item.body) !== null;

/** Cuts a long text for the wire, and says whether it did. */
export const clipHomeText = (text: string): { readonly text: string; readonly clipped: boolean } =>
  text.length <= HOME_TEXT_LIMIT
    ? { text, clipped: false }
    : { text: `${text.slice(0, HOME_TEXT_LIMIT - 1)}…`, clipped: true };
