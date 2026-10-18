import {
  compareHomeNeeds,
  type HomeAnswer,
  type HomeDetail,
  type HomeItem,
  homeItemKey,
  type HomeSummary,
  homeSummaryKey,
  isHomeNeed,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { connectMagnesium, type MagnesiumRpcClient } from "./rpc.ts";
import {
  applyLiveTableItem,
  emptyLiveTable,
  type LiveTableState,
  resumeFrom,
} from "./stream/liveTable.ts";

/**
 * Home in the browser (goal 06): the hub's `magnesium.home.needs` and
 * `magnesium.home.summary`, kept live over one socket that resumes after a
 * drop, and the calls that answer, pin and open an item. The sidebar's place,
 * the page and the footer share one watch. This module holds no React.
 */

export interface HomeView {
  readonly items: LiveTableState<HomeItem>;
  readonly summary: HomeSummary | null;
  /** `connecting` until the hub first answers; `reconnecting` after a drop. */
  readonly connection: "connecting" | "live" | "reconnecting";
}

export const initialHomeView: HomeView = {
  items: emptyLiveTable(),
  summary: null,
  connection: "connecting",
};

export interface HomeWatch {
  /** Sends an answer now; the hold before it lives in `createAnswerHold`. */
  readonly answer: (key: string, answer: HomeAnswer) => Promise<void>;
  readonly pin: (key: string, pinned: boolean) => Promise<void>;
  /** The item's thread's latest work, fetched when Detail opens a card. */
  readonly detail: (key: string) => Promise<HomeDetail>;
  readonly dispose: () => void;
}

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

/** The sentence a refused call carries, for the card. */
const reasonOf = (error: unknown): Error =>
  new Error(
    typeof error === "object" &&
      error !== null &&
      "detail" in error &&
      typeof error.detail === "string"
      ? error.detail
      : "The hub did not take that. Try again.",
  );

/** Follows the hub's Home over its route at `socketUrl` until disposed. */
export function watchHome(socketUrl: string, onView: (view: HomeView) => void): HomeWatch {
  let view = initialHomeView;
  let client: MagnesiumRpcClient | null = null;
  let summaryTable = emptyLiveTable<HomeSummary>();
  const update = (next: HomeView) => {
    if (next === view) return;
    view = next;
    onView(view);
  };

  const session = Effect.gen(function* () {
    const connected = yield* connectMagnesium(socketUrl);
    client = connected;
    const items = connected[MAGNESIUM_WS_METHODS.homeNeeds](resumeFrom(view.items)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          const next = applyLiveTableItem(view.items, item, homeItemKey);
          if (next !== view.items || view.connection !== "live") {
            update({ ...view, items: next, connection: "live" });
          }
        }),
      ),
    );
    const summary = connected[MAGNESIUM_WS_METHODS.homeSummary](resumeFrom(summaryTable)).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          summaryTable = applyLiveTableItem(summaryTable, item, homeSummaryKey);
          const row = summaryTable.rows.get("home") ?? null;
          if (row !== view.summary) update({ ...view, summary: row });
        }),
      ),
    );
    yield* Effect.all([items, summary], { concurrency: "unbounded", discard: true });
  }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => void (client = null))));

  const loop = Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      const wasLive = view.connection === "live";
      yield* session.pipe(Effect.exit);
      // A session that got going starts the backoff over.
      attempt = view.connection === "live" && !wasLive ? 1 : attempt + 1;
      update({ ...view, connection: "reconnecting" });
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (attempt - 1));
      yield* Effect.sleep(Duration.millis(wait));
    }
  });

  const fiber = Effect.runFork(loop);

  const withClient = <A, E>(use: (client: MagnesiumRpcClient) => Effect.Effect<A, E>) =>
    client === null
      ? Promise.reject(new Error("Not connected to the hub."))
      : Effect.runPromise(use(client).pipe(Effect.mapError(reasonOf)));

  return {
    answer: (key, answer) =>
      withClient((connected) => connected[MAGNESIUM_WS_METHODS.homeAnswer]({ key, answer })),
    pin: (key, pinned) =>
      withClient((connected) => connected[MAGNESIUM_WS_METHODS.homePin]({ key, pinned })),
    detail: (key) => withClient((connected) => connected[MAGNESIUM_WS_METHODS.homeDetail]({ key })),
    dispose: () => void Effect.runFork(Fiber.interrupt(fiber)),
  };
}

/** What needs you, in Home's order (D18): pins, then kind, then the longest wait. */
export const homeNeeds = (items: LiveTableState<HomeItem>): ReadonlyArray<HomeItem> =>
  [...items.rows.values()].filter(isHomeNeed).sort(compareHomeNeeds);

/** What is working now, longest-running first. */
export const homeRunning = (items: LiveTableState<HomeItem>): ReadonlyArray<HomeItem> =>
  [...items.rows.values()]
    .filter((item) => item.body._tag === "running")
    .sort((left, right) => left.since.localeCompare(right.since));

/** Each scheduled task's next run, soonest first (goal 24). */
export const homeNextRuns = (items: LiveTableState<HomeItem>): ReadonlyArray<HomeItem> =>
  [...items.rows.values()]
    .filter((item) => item.body._tag === "scheduled")
    .sort(
      (left, right) => left.since.localeCompare(right.since) || left.key.localeCompare(right.key),
    );

/** A run's time as the board writes it: "14:00" today, "Sat 02:00" this week, else the date. */
export function runTime(at: string, now: number): string {
  const when = Date.parse(at);
  const clock = new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(when);
  const day = new Intl.DateTimeFormat([], { dateStyle: "short" });
  if (day.format(when) === day.format(now)) return clock;
  if (when - now < 6 * 24 * 60 * 60 * 1000) {
    return `${new Intl.DateTimeFormat([], { weekday: "short" }).format(when)} ${clock}`;
  }
  return `${new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(when)} ${clock}`;
}

export interface HomeNeedGroup {
  readonly label: string;
  /** False for a machine the hub can't reach: its needs can't be answered yet. */
  readonly reachable: boolean;
  /** Its needs in Home's order, at most the limit. */
  readonly needs: ReadonlyArray<HomeItem>;
  /** How many more past the limit. */
  readonly more: number;
}

/**
 * Needs you in the footer: each machine with something waiting, in the order
 * of its most urgent need, then machines the hub can't see and holds nothing
 * from. `needs` comes in Home's order and keeps it within each machine.
 */
export function homeNeedsByMachine(
  needs: ReadonlyArray<HomeItem>,
  unseen: ReadonlyArray<string>,
  limit = 5,
): ReadonlyArray<HomeNeedGroup> {
  const groups = new Map<string, { reachable: boolean; needs: Array<HomeItem> }>();
  for (const need of needs) {
    const group = groups.get(need.machine.label);
    if (group === undefined) {
      groups.set(need.machine.label, { reachable: need.reachable, needs: [need] });
    } else group.needs.push(need);
  }
  return [
    ...[...groups].map(([label, group]) => ({
      label,
      reachable: group.reachable,
      needs: group.needs.slice(0, limit),
      more: Math.max(0, group.needs.length - limit),
    })),
    ...unseen
      .filter((label) => !groups.has(label))
      .map((label) => ({ label, reachable: false, needs: [], more: 0 })),
  ];
}

/** How long since `since`, as the board writes it: "now", "6m", "2h", "3d". */
export function waitedFor(since: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The header's line: "5 need you · 4 running · next run 14:00", or what the hub can't see. */
export function describeHome(
  summary: HomeSummary | null,
  nextRun: { readonly at: string; readonly now: number } | null = null,
): string {
  if (summary === null) return "Loading…";
  const parts = [
    summary.counts.total === 0 ? "Nothing needs you" : `${summary.counts.total} need you`,
  ];
  if (summary.counts.running > 0) parts.push(`${summary.counts.running} running`);
  if (nextRun !== null) parts.push(`next run ${runTime(nextRun.at, nextRun.now)}`);
  if (summary.unseen.length > 0) parts.push(`not counted: ${summary.unseen.join(", ")}`);
  return parts.join(" · ");
}

/** The kind of a need, as its card heads it. */
export function describeNeed(item: HomeItem): string {
  switch (item.body._tag) {
    case "approval":
      switch (item.body.requestKind) {
        case "command":
          return "Command approval";
        case "file-change":
          return "File change approval";
        case "file-read":
          return "File read approval";
        case "mcp-elicitation":
          return "Tool approval";
        default:
          return "Approval";
      }
    case "question":
      return item.body.questions.length > 1
        ? `${item.body.questions.length} questions`
        : "Question";
    case "plan":
      return "Plan ready";
    case "failure":
      return item.body.taskId === undefined ? "Run failed" : "Scheduled run failed";
    case "scheduled-failure":
      return "Scheduled run failed";
    case "running":
      return "Working";
    case "scheduled":
      return "Scheduled";
  }
}

// ── The hold before an answer is sent (goal 06: Undo) ──

/** How long an answer waits before it is sent, so Undo can take it back. */
export const ANSWER_HOLD_MS = 5_000;
/** How long a sent answer keeps its card hidden while the hub catches up. */
const SENT_HIDE_MS = 15_000;

export type HeldAnswer =
  | {
      readonly state: "holding";
      readonly answer: HomeAnswer;
      readonly sendsAt: number;
      /** A short name for the answer, for "Approving in 4s". */
      readonly label: string;
    }
  | { readonly state: "sending"; readonly answer: HomeAnswer; readonly label: string }
  | { readonly state: "sent"; readonly answer: HomeAnswer; readonly label: string }
  | {
      readonly state: "failed";
      readonly answer: HomeAnswer;
      readonly label: string;
      readonly error: string;
    };

export interface AnswerHold {
  /** Holds `answer` for `key`, replacing one already held; it sends when the hold runs out. */
  readonly hold: (key: string, answer: HomeAnswer, label: string) => void;
  /** Takes back an answer still held. Nothing was sent. */
  readonly undo: (key: string) => void;
  /** Clears a failed answer so the card can be answered again. */
  readonly dismiss: (key: string) => void;
  readonly current: () => ReadonlyMap<string, HeldAnswer>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Answers held before they are sent. One per card: the card shows it in
 * place of its controls, with Undo while it holds and the reason if it
 * failed. The timers are injectable so tests run without waiting.
 */
export function createAnswerHold(options: {
  readonly send: (key: string, answer: HomeAnswer) => Promise<void>;
  readonly holdMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}): AnswerHold {
  const holdMs = options.holdMs ?? ANSWER_HOLD_MS;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      // A UI countdown outside any Effect: a plain timer is the whole job.
      // @effect-diagnostics-next-line globalTimers:off
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let held: ReadonlyMap<string, HeldAnswer> = new Map();
  const timers = new Map<string, () => void>();
  const listeners = new Set<() => void>();

  const set = (key: string, next: HeldAnswer | null) => {
    const copy = new Map(held);
    if (next === null) copy.delete(key);
    else copy.set(key, next);
    held = copy;
    for (const listener of listeners) listener();
  };
  const clearTimer = (key: string) => {
    timers.get(key)?.();
    timers.delete(key);
  };

  const send = (key: string, answer: HomeAnswer, label: string) => {
    timers.delete(key);
    set(key, { state: "sending", answer, label });
    options.send(key, answer).then(
      () => {
        if (held.get(key)?.state !== "sending") return;
        set(key, { state: "sent", answer, label });
        timers.set(
          key,
          setTimer(() => {
            timers.delete(key);
            if (held.get(key)?.state === "sent") set(key, null);
          }, SENT_HIDE_MS),
        );
      },
      (error: unknown) => {
        if (held.get(key)?.state !== "sending") return;
        set(key, {
          state: "failed",
          answer,
          label,
          error: error instanceof Error ? error.message : "It did not go through.",
        });
      },
    );
  };

  return {
    hold: (key, answer, label) => {
      const current = held.get(key);
      if (current?.state === "sending" || current?.state === "sent") return;
      clearTimer(key);
      set(key, { state: "holding", answer, sendsAt: now() + holdMs, label });
      timers.set(
        key,
        setTimer(() => send(key, answer, label), holdMs),
      );
    },
    undo: (key) => {
      if (held.get(key)?.state !== "holding") return;
      clearTimer(key);
      set(key, null);
    },
    dismiss: (key) => {
      if (held.get(key)?.state !== "failed") return;
      set(key, null);
    },
    current: () => held,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
