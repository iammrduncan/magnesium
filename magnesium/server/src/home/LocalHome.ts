import {
  HomeAnswerError,
  type HomeDetail,
  type LiveTableItem,
  type LocalAnswerInput,
  type LocalHomeItem,
  localHomeItemKey,
  type StreamSubscribeInput,
} from "@magnesium/contracts";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcRef from "effect/RcRef";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerPorts } from "../ports.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import { viewOf } from "../threads.ts";
import {
  answeredKey,
  commandsForAnswer,
  homeItemsOf,
  needsThreadRequests,
  planMarkdownOf,
  recentWorkOf,
  scheduleFailureKey,
  scheduleItemsOf,
  withRetryTask,
} from "./items.ts";

/**
 * This server's part of Home (goal 06): its threads' open approvals and
 * questions, plans ready, failures and work in progress, as a live table the
 * hub follows on every machine. Kept from the server's own projections while
 * anyone subscribes, as `ServerStatus` is. Answers are checked against the
 * thread as it is now, so a card that went stale is refused, not sent.
 */

const THREAD_COALESCE = Duration.millis(50);
const RETRY_AFTER = Duration.seconds(5);
const IDLE_TIME_TO_LIVE = Duration.seconds(30);
/** Reread everything now and then: a snooze that ran out, a renamed project. */
const RESYNC_EVERY = Duration.minutes(1);
/** A server's items: a few per waiting thread, one per working thread. */
const MAX_ITEMS = 1_000;

export class LocalHome extends Context.Service<
  LocalHome,
  {
    readonly subscribe: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<LocalHomeItem>>;
    readonly answer: (input: LocalAnswerInput) => Effect.Effect<void, HomeAnswerError>;
    readonly detail: (threadId: ThreadId) => Effect.Effect<HomeDetail, HomeAnswerError>;
  }
>()("@magnesium/server/home/LocalHome") {}

const answerError = (detail: string) => new HomeAnswerError({ detail });

export const layer = Layer.effect(
  LocalHome,
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const crypto = yield* Crypto.Crypto;
    const table = yield* LiveTable.make<LocalHomeItem>({
      key: localHomeItemKey,
      maxRows: MAX_ITEMS,
    });
    const keysByThread = new Map<ThreadId, ReadonlySet<string>>();
    let scheduleKeys: ReadonlySet<string> = new Set();
    let projectTitles = new Map<string, string>();

    const loadProjectTitles = ports.threads.projects.pipe(
      Effect.map((projects) => {
        projectTitles = new Map(projects.map((project) => [project.id, project.title]));
      }),
      Effect.ignore,
    );

    const projectTitleOf = (projectId: string) =>
      Effect.gen(function* () {
        if (!projectTitles.has(projectId)) yield* loadProjectTitles;
        return projectTitles.get(projectId) ?? null;
      });

    const itemsOf = (shell: OrchestrationV2ThreadShell) =>
      Effect.gen(function* () {
        const view = viewOf(shell);
        const requests = needsThreadRequests(view)
          ? Option.getOrNull(yield* ports.threads.requests(shell.id))
          : null;
        const items = homeItemsOf({
          view,
          requests,
          projectTitle: yield* projectTitleOf(shell.projectId),
          now: DateTime.formatIso(yield* DateTime.now),
        });
        // Only a failure on show is worth reading its run for; settled ones stay failed.
        if (shell.latestRunId === null || !items.some((item) => item.body._tag === "failure")) {
          return items;
        }
        const task = yield* ports.threads
          .scheduledTaskOf(shell.id, shell.latestRunId)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        return Option.isSome(task) ? withRetryTask(items, task.value) : items;
      });

    /** Make the table hold exactly `items` for this thread. */
    const place = (threadId: ThreadId, items: ReadonlyArray<LocalHomeItem>) =>
      Effect.gen(function* () {
        const next = new Set(items.map(localHomeItemKey));
        for (const key of keysByThread.get(threadId) ?? []) {
          if (!next.has(key)) yield* table.remove(key);
        }
        for (const item of items) yield* table.set(item);
        if (next.size === 0) keysByThread.delete(threadId);
        else keysByThread.set(threadId, next);
      });

    /** Make the table hold exactly `items` for the scheduled tasks. */
    const placeSchedule = (items: ReadonlyArray<LocalHomeItem>) =>
      Effect.gen(function* () {
        const next = new Set(items.map(localHomeItemKey));
        for (const key of scheduleKeys) if (!next.has(key)) yield* table.remove(key);
        for (const item of items) yield* table.set(item);
        scheduleKeys = next;
      });

    /** Follows the scheduler: every task's next run, and a run that could not start. */
    const followSchedule = ports.schedule.tasks.pipe(
      Stream.runForEach((tasks) =>
        Effect.gen(function* () {
          for (const task of tasks) yield* projectTitleOf(task.projectId);
          yield* placeSchedule(scheduleItemsOf(tasks, (id) => projectTitles.get(id) ?? null));
        }),
      ),
    );

    const refresh = (threadId: ThreadId) =>
      ports.threads.byId(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => place(threadId, []),
            onSome: (shell) =>
              itemsOf(shell).pipe(Effect.flatMap((items) => place(threadId, items))),
          }),
        ),
      );

    const readAll = Effect.gen(function* () {
      yield* loadProjectTitles;
      const active = yield* ports.threads.active;
      const seen = new Set<ThreadId>();
      for (const shell of active) {
        seen.add(shell.id);
        yield* place(shell.id, yield* itemsOf(shell));
      }
      for (const threadId of [...keysByThread.keys()]) {
        if (!seen.has(threadId)) yield* place(threadId, []);
      }
    });

    /** Reads every thread, then follows each change; `loaded` completes after the first read. */
    const track = (loaded: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        // Listen before reading, so a change during the read is not lost.
        const changed = yield* Queue.unbounded<ThreadId>();
        yield* Effect.forkScoped(
          ports.threads.changes.pipe(
            Stream.runForEach((threadId) => Queue.offer(changed, threadId)),
          ),
          { startImmediately: true },
        );
        yield* readAll;
        yield* Deferred.succeed(loaded, undefined);
        // The scheduler's own stream sends the list now and after each change.
        yield* Effect.forkScoped(followSchedule);
        yield* readAll.pipe(
          Effect.delay(RESYNC_EVERY),
          Effect.repeat(Schedule.forever),
          Effect.forkScoped,
        );
        yield* Stream.fromQueue(changed).pipe(
          Stream.groupedWithin(512, THREAD_COALESCE),
          Stream.runForEach((ids) => Effect.forEach(new Set(ids), refresh, { discard: true })),
        );
      }).pipe(Effect.scoped);

    const tracker = yield* RcRef.make({
      acquire: Effect.gen(function* () {
        const loaded = yield* Deferred.make<void>();
        yield* track(loaded).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Lost track of this server's Home items; starting over.", {
              cause,
            }).pipe(Effect.andThen(Deferred.succeed(loaded, undefined))),
          ),
          Effect.andThen(Effect.sleep(RETRY_AFTER)),
          Effect.forever,
          Effect.forkScoped,
        );
        // A first subscriber sees the real items, not an empty table before the first read.
        yield* Deferred.await(loaded);
      }),
      idleTimeToLive: IDLE_TIME_TO_LIVE,
    });

    const answer = ({ threadId, answer: given }: LocalAnswerInput) =>
      Effect.gen(function* () {
        if (given._tag === "retry" && threadId === null) {
          if (!scheduleKeys.has(scheduleFailureKey(given.taskId))) {
            return yield* answerError("That run already started again, or the task is gone.");
          }
          return yield* ports.schedule.runNow(given.taskId);
        }
        if (threadId === null) return yield* answerError("That answer needs a thread.");
        const shell = Option.getOrUndefined(yield* ports.threads.byId(threadId));
        if (shell === undefined) return yield* answerError("That thread is gone.");
        // The thread as it is now: an item answered elsewhere, or left behind, is refused.
        const open = (yield* itemsOf(shell)).find(
          (item) => item.key === answeredKey(threadId, given),
        );
        if (open === undefined) {
          return yield* answerError("It was already answered, or the agent moved on.");
        }
        if (given._tag === "retry") {
          if (open.body._tag !== "failure" || open.body.taskId !== given.taskId) {
            return yield* answerError("That run wasn't started by this scheduled task.");
          }
          yield* ports.schedule.runNow(given.taskId);
        }
        let planMarkdown: string | undefined;
        if (given._tag === "plan") {
          const requests = Option.getOrNull(yield* ports.threads.requests(threadId));
          const plan = requests?.plans.find(
            (candidate) => candidate.kind === "proposed_plan" && candidate.id === given.planId,
          );
          if (requests === null || plan === undefined || plan.kind !== "proposed_plan") {
            return yield* answerError("That plan is gone.");
          }
          planMarkdown = planMarkdownOf(requests, plan);
        }
        // An answer is at most two commands and one message.
        const commandIds = [yield* crypto.randomUUIDv4(), yield* crypto.randomUUIDv4()];
        const messageId = MessageId.make(yield* crypto.randomUUIDv4());
        const commands = commandsForAnswer({
          view: viewOf(shell),
          answer: given,
          ...(planMarkdown === undefined ? {} : { planMarkdown }),
          context: {
            commandId: () => CommandId.make(commandIds.shift() ?? "command"),
            messageId: () => messageId,
          },
        });
        for (const command of commands) yield* ports.threads.dispatch(command);
      }).pipe(
        Effect.catchTags({
          ServerPortError: (error) => Effect.fail(answerError(error.detail)),
          PlatformError: () => Effect.fail(answerError("Could not make an id for the answer.")),
        }),
      );

    const detail = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = Option.getOrUndefined(yield* ports.threads.byId(threadId));
        if (shell === undefined) return yield* answerError("That thread is gone.");
        const runId = shell.latestRunId;
        const items = runId === null ? [] : yield* ports.threads.recentWork(threadId, runId);
        return { activities: recentWorkOf(items) };
      }).pipe(
        Effect.catchTags({
          ServerPortError: (error) => Effect.fail(answerError(error.detail)),
        }),
      );

    return LocalHome.of({
      subscribe: (input) =>
        Stream.unwrap(RcRef.get(tracker).pipe(Effect.as(table.subscribe(input)))),
      answer,
      detail,
    });
  }),
);
