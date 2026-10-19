import { MAGNESIUM_WS_METHODS } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { connect } from "../rpc/client.ts";
import { startTestServer } from "../testing.ts";

describe("profiles over the hub's RPC (goal 34)", () => {
  it.live("an operator creates, changes and reads a profile; a reader only reads", () =>
    Effect.gen(function* () {
      const server = yield* startTestServer();
      const operator = yield* connect(server.wsUrl("operator"));
      const created = yield* operator[MAGNESIUM_WS_METHODS.profileCreate]({ name: "scratch-b" });
      expect(created).toMatchObject({ saved: true, version: 1 });
      yield* operator[MAGNESIUM_WS_METHODS.profileSave]({
        name: "scratch-b",
        files: [{ path: "CLAUDE.md", content: "End every reply with the word `ok-b`.\n" }],
      });
      const detail = yield* operator[MAGNESIUM_WS_METHODS.profileDetail]({ name: "scratch-b" });
      expect(detail.files.map((file) => file.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(detail.history[0]).toMatchObject({ version: 2, by: "You" });

      const reader = yield* connect(server.wsUrl("reader"));
      expect(
        (yield* reader[MAGNESIUM_WS_METHODS.profileDetail]({ name: "scratch-b" })).version,
      ).toBe(2);
      const refused = yield* reader[MAGNESIUM_WS_METHODS.profileSave]({
        name: "scratch-b",
        files: [{ path: "CLAUDE.md", content: "x" }],
      }).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "EnvironmentAuthorizationError" });

      const missing = yield* operator[MAGNESIUM_WS_METHODS.profileDetail]({ name: "nope" }).pipe(
        Effect.flip,
      );
      expect(missing).toMatchObject({ _tag: "ProfileError" });
    }).pipe(Effect.scoped),
  );
});
