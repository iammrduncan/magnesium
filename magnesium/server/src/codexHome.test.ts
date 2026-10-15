import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { inCodexHomeTurn, takeCodexHomeTurn } from "./codexHome.ts";

/** A start that records when it ran, as a spawn followed by `initialize` would. */
const recorder = () => {
  const log: string[] = [];
  const start = (name: string, outcome: "ok" | "fail" = "ok") =>
    Effect.gen(function* () {
      log.push(`${name} spawned`);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      log.push(`${name} initialized`);
      if (outcome === "fail") return yield* Effect.fail(`${name} failed`);
      return name;
    });
  return { log, start };
};

describe("Codex home turns", () => {
  it.effect("starts in a fresh home take turns until one has initialized, then run together", () =>
    Effect.gen(function* () {
      const home = "/mg-test/codex-home-turns";
      const { log, start } = recorder();
      const first = yield* Effect.all(
        [inCodexHomeTurn(home, start("a")), inCodexHomeTurn(home, start("b"))],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(first, ["a", "b"]);
      assert.deepEqual(log, ["a spawned", "a initialized", "b spawned", "b initialized"]);

      // The home is set up now: later starts don't wait for each other.
      log.length = 0;
      yield* Effect.all([inCodexHomeTurn(home, start("c")), inCodexHomeTurn(home, start("d"))], {
        concurrency: "unbounded",
      });
      assert.deepEqual(log, ["c spawned", "d spawned", "c initialized", "d initialized"]);
    }),
  );

  it.effect("a start that fails lets the next one set the home up", () =>
    Effect.gen(function* () {
      const home = "/mg-test/codex-home-failed-start";
      const { log, start } = recorder();
      const results = yield* Effect.all(
        [
          Effect.result(inCodexHomeTurn(home, start("a", "fail"))),
          Effect.result(inCodexHomeTurn(home, start("b"))),
          Effect.result(inCodexHomeTurn(home, start("c"))),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        results.map((result) => result._tag),
        ["Failure", "Success", "Success"],
      );
      assert.deepEqual(log.slice(0, 4), [
        "a spawned",
        "a initialized",
        "b spawned",
        "b initialized",
      ]);
    }),
  );

  it.effect("homes don't wait for each other", () =>
    Effect.gen(function* () {
      const base = "/mg-test/codex-home-separate";
      const held = yield* takeCodexHomeTurn(`${base}-one`);
      const other = yield* Effect.forkChild(takeCodexHomeTurn(`${base}-two`));
      const turn = yield* Fiber.join(other);
      yield* turn.release;
      yield* held.release;
    }),
  );
});
