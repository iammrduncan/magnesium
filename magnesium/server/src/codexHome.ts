// @effect-diagnostics nodeBuiltinImport:off - resolves Codex's default home the way Codex does.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Codex can't set up a fresh CODEX_HOME from two processes at once: the others
 * exit with "failed to initialize sqlite state runtime". A provider refresh
 * starts every instance that shares a home in the same instant (a stock
 * instance and its native twin, a profile's sandbox levels), so until one
 * app-server has answered `initialize` in a home, starts in that home take
 * turns. After that they run side by side, as Codex allows.
 */
const readyHomes = new Set<string>();
const turns = new Map<string, Semaphore.Semaphore>();

export interface CodexHomeTurn {
  /** This start's app-server answered `initialize`: the home is set up, and the next start may go. */
  readonly ready: Effect.Effect<void>;
  /** The next start may go, whether or not this one got that far. Safe to run more than once. */
  readonly release: Effect.Effect<void>;
}

const keyOf = (home: string | undefined) =>
  NodePath.resolve(home ?? process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"));

/** Waits for the home's turn, unless the home is already set up. `home` unset is Codex's default. */
export const takeCodexHomeTurn = (home: string | undefined): Effect.Effect<CodexHomeTurn> =>
  Effect.suspend(() => {
    const key = keyOf(home);
    const free = { ready: Effect.void, release: Effect.void } satisfies CodexHomeTurn;
    if (readyHomes.has(key)) return Effect.succeed(free);
    let semaphore = turns.get(key);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(1);
      turns.set(key, semaphore);
    }
    const held = semaphore;
    return held.take(1).pipe(
      Effect.map(() => {
        let released = false;
        const release = Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          return held.release(1).pipe(Effect.asVoid);
        });
        // Another start may have set the home up while this one waited.
        if (readyHomes.has(key)) return { ready: release, release } satisfies CodexHomeTurn;
        return {
          ready: Effect.sync(() => readyHomes.add(key)).pipe(Effect.andThen(release)),
          release,
        } satisfies CodexHomeTurn;
      }),
    );
  });

/** Runs `start` (spawn an app-server and initialize it) in the home's turn. */
export const inCodexHomeTurn = <A, E, R>(
  home: string | undefined,
  start: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    takeCodexHomeTurn(home),
    (turn) => start.pipe(Effect.tap(() => turn.ready)),
    (turn) => turn.release,
  );
