import type { ServerStatus, ServerStatusItem } from "@magnesium/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * The hub's link to one machine (goal 04, D35: the hub dials out). A link is
 * the machine's `magnesium.server.status` subscription plus a heartbeat ping,
 * so a machine that stops answering is noticed within about five seconds even
 * when its socket stays open. A dropped link redials with backoff; a link that
 * held for a while starts over from the shortest wait, and one that keeps
 * dropping waits longer each time, so a flapping machine costs a little and
 * never floods the browser.
 */

/** What dialing a machine gives the link; either fails with `E` when the link drops. */
export interface LinkConnection<E> {
  readonly status: Stream.Stream<ServerStatusItem, E>;
  readonly ping: Effect.Effect<unknown, E>;
}

/** Why a dial failed: the hub holds no usable token, or the machine did not answer. */
export class LinkDialError extends Schema.TaggedError<LinkDialError>()("LinkDialError", {
  link: Schema.Literals(["offline", "no-access"]),
  detail: Schema.String,
}) {}
const isLinkDialError = Schema.is(LinkDialError);

export interface LinkDown {
  readonly link: "offline" | "no-access";
  readonly detail: string;
  /** When the machine last answered, if it ever did on this link. */
  readonly lastSeenAt: number | null;
}

export interface LinkHandlers {
  readonly onStatus: (status: ServerStatus) => Effect.Effect<void>;
  readonly onDown: (down: LinkDown) => Effect.Effect<void>;
}

export interface LinkTimings {
  readonly pingEvery: Duration.Duration;
  readonly pingTimeout: Duration.Duration;
  readonly backoffInitial: Duration.Duration;
  readonly backoffMax: Duration.Duration;
  /** A link up this long counts as healthy: its next drop retries at the shortest wait. */
  readonly stableAfter: Duration.Duration;
  /** How often to retry a machine the hub has no access to. */
  readonly noAccessRetry: Duration.Duration;
  /** Spread retries by up to this fraction, so machines do not redial in step. */
  readonly jitter: number;
}

export const DEFAULT_LINK_TIMINGS: LinkTimings = {
  pingEvery: Duration.seconds(2),
  pingTimeout: Duration.seconds(3),
  backoffInitial: Duration.seconds(1),
  backoffMax: Duration.seconds(15),
  stableAfter: Duration.seconds(30),
  noAccessRetry: Duration.seconds(30),
  jitter: 0.2,
};

/** The wait before retry `attempt` (1 for the first retry). */
export const backoffDelay = (timings: LinkTimings, attempt: number): Duration.Duration => {
  const base = Duration.toMillis(timings.backoffInitial) * 2 ** Math.max(0, attempt - 1);
  return Duration.millis(Math.min(Duration.toMillis(timings.backoffMax), base));
};

const describeDrop = (error: unknown): string => {
  if (isLinkDialError(error)) return error.detail;
  if (Predicate.isTagged(error, "TimeoutError")) return "It stopped answering.";
  if (Predicate.isTagged(error, "EnvironmentAuthorizationError")) {
    return "It refused the hub's scopes.";
  }
  return "The connection dropped.";
};

/**
 * Runs one machine's link until interrupted. `wake` cuts a backoff wait
 * short: the owner asked to reconnect, or the hub's access changed.
 */
export const runLink = <E>(input: {
  readonly dial: Effect.Effect<LinkConnection<E>, LinkDialError, Scope.Scope>;
  readonly handlers: LinkHandlers;
  readonly wake: Queue.Queue<void>;
  readonly timings?: LinkTimings;
}): Effect.Effect<never> => {
  const timings = input.timings ?? DEFAULT_LINK_TIMINGS;
  const { handlers } = input;

  const once = Effect.gen(function* () {
    let connectedAt: number | null = null;
    let lastSeenAt: number | null = null;
    const alive = Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        lastSeenAt = now;
        connectedAt ??= now;
      }),
    );
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* input.dial;
        const status = connection.status.pipe(
          Stream.runForEach((item) => {
            const row = item._tag === "snapshot" ? item.rows[0] : item.upserts[0];
            return row === undefined ? alive : alive.pipe(Effect.andThen(handlers.onStatus(row)));
          }),
        );
        const heartbeat = Effect.sleep(timings.pingEvery).pipe(
          Effect.andThen(connection.ping.pipe(Effect.timeout(timings.pingTimeout))),
          Effect.andThen(alive),
          Effect.forever,
        );
        yield* Effect.raceFirst(status, heartbeat);
      }),
    ).pipe(Effect.result);
    const now = yield* Clock.currentTimeMillis;
    const down: LinkDown = {
      link:
        outcome._tag === "Failure" && isLinkDialError(outcome.failure)
          ? outcome.failure.link
          : "offline",
      detail:
        outcome._tag === "Failure" ? describeDrop(outcome.failure) : "The machine closed the link.",
      lastSeenAt,
    };
    const stable =
      connectedAt !== null && now - connectedAt >= Duration.toMillis(timings.stableAfter);
    return { down, stable };
  });

  return Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      // A reconnect asked for before this try is served by it.
      yield* Queue.clear(input.wake);
      const { down, stable } = yield* once;
      yield* handlers.onDown(down);
      attempt = stable ? 1 : attempt + 1;
      const base =
        down.link === "no-access" ? timings.noAccessRetry : backoffDelay(timings, attempt);
      const spread = 1 + (yield* Random.next) * timings.jitter;
      const wait = Duration.millis(Math.round(Duration.toMillis(base) * spread));
      yield* Queue.take(input.wake).pipe(
        Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.void }),
      );
    }
  });
};
