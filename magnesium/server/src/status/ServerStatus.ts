import type {
  LiveTableItem,
  ServerDeployment,
  ServerStatus as ServerStatusRow,
  StreamSubscribeInput,
  ThreadCounts,
} from "@magnesium/contracts";
import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcRef from "effect/RcRef";
import * as Stream from "effect/Stream";

import { ServerPorts } from "../ports.ts";
import * as LiveTable from "../stream/LiveTable.ts";
import { currentRelease, deploymentOf } from "./release.ts";

/**
 * What this server says about itself: version, start time, and a count of its
 * threads by what they need. Kept live from the server's own projections while
 * anyone subscribes, so the hub's one subscription per machine (goal 04) costs
 * a few hundred bytes per change, never a thread list, and a server nobody
 * watches does no work for it.
 */

/** A thread, reduced to what the counts need. */
export interface ThreadState {
  readonly running: boolean;
  readonly approval: boolean;
  readonly question: boolean;
}

/** The same precedence as the sidebar's status pill: what needs you outranks work. */
export const threadStateOf = (thread: OrchestrationThreadShell): ThreadState => {
  const approval = thread.hasPendingApprovals;
  const question = thread.hasPendingUserInput;
  const busy =
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working";
  return { running: busy && !approval && !question, approval, question };
};

export const countThreads = (threads: Iterable<ThreadState>): ThreadCounts => {
  let total = 0;
  let running = 0;
  let waiting = 0;
  let approvals = 0;
  let questions = 0;
  for (const thread of threads) {
    total += 1;
    if (thread.running) running += 1;
    if (thread.approval || thread.question) waiting += 1;
    if (thread.approval) approvals += 1;
    if (thread.question) questions += 1;
  }
  return { total, running, waiting, approvals, questions };
};

/** Thread events come in bursts while a turn streams; re-read each thread once per window. */
const THREAD_COALESCE = Duration.millis(50);
const RETRY_AFTER = Duration.seconds(5);
/** Keep following the threads this long after the last subscriber leaves, for quick resubscribes. */
const IDLE_TIME_TO_LIVE = Duration.seconds(30);

export class ServerStatus extends Context.Service<
  ServerStatus,
  {
    readonly serverVersion: string;
    /** The build it runs; null in development. */
    readonly release: string | null;
    /** How it is deployed; null when `MAGNESIUM_DEPLOY` is unset. */
    readonly deployment: ServerDeployment | null;
    readonly startedAt: string;
    /** The status as a one-row table. Threads are followed only while someone subscribes. */
    readonly subscribe: (
      input: StreamSubscribeInput,
    ) => Stream.Stream<LiveTableItem<ServerStatusRow>>;
  }
>()("@magnesium/server/status/ServerStatus") {}

export const layer = Layer.effect(
  ServerStatus,
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const descriptor = yield* ports.environment;
    const release = yield* currentRelease;
    const deployment = deploymentOf(process.env.MAGNESIUM_DEPLOY);
    const table = yield* LiveTable.make<ServerStatusRow>({ key: (row) => row.environmentId });
    const threads = new Map<ThreadId, ThreadState>();

    const publish = Effect.suspend(() =>
      table.set({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        release,
        deployment,
        startedAt,
        threads: countThreads(threads.values()),
      }),
    );

    const refresh = (threadId: ThreadId) =>
      ports.threads.byId(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => void threads.delete(threadId),
            onSome: (thread) => void threads.set(threadId, threadStateOf(thread)),
          }),
        ),
      );

    /** Reads every thread, then follows each change; `loaded` completes after the first read. */
    const track = (loaded: Deferred.Deferred<void>) =>
      Effect.gen(function* () {
        // Listen before reading the threads, so a change during the read is not lost.
        const changed = yield* Queue.unbounded<ThreadId>();
        yield* Effect.forkScoped(
          ports.threads.changes.pipe(
            Stream.runForEach((threadId) => Queue.offer(changed, threadId)),
          ),
          { startImmediately: true },
        );
        const active = yield* ports.threads.active;
        threads.clear();
        for (const thread of active) threads.set(thread.id, threadStateOf(thread));
        yield* publish;
        yield* Deferred.succeed(loaded, undefined);
        yield* Stream.fromQueue(changed).pipe(
          Stream.groupedWithin(512, THREAD_COALESCE),
          Stream.runForEach((ids) =>
            Effect.forEach(new Set(ids), refresh, { discard: true }).pipe(Effect.andThen(publish)),
          ),
        );
      }).pipe(Effect.scoped);

    const tracker = yield* RcRef.make({
      acquire: Effect.gen(function* () {
        const loaded = yield* Deferred.make<void>();
        yield* track(loaded).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Lost track of this server's threads; starting over.", {
              cause,
            }).pipe(Effect.andThen(Deferred.succeed(loaded, undefined))),
          ),
          Effect.andThen(Effect.sleep(RETRY_AFTER)),
          Effect.forever,
          Effect.forkScoped,
        );
        // A first subscriber sees real counts, not the zeros before the first read.
        yield* Deferred.await(loaded);
      }),
      idleTimeToLive: IDLE_TIME_TO_LIVE,
    });

    yield* publish;
    return ServerStatus.of({
      serverVersion: descriptor.serverVersion,
      release,
      deployment,
      startedAt,
      subscribe: (input) =>
        Stream.unwrap(RcRef.get(tracker).pipe(Effect.as(table.subscribe(input)))),
    });
  }),
);
