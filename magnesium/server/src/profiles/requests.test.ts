// @effect-diagnostics globalFetchInEffect:off preferSchemaOverJson:off - the test is an agent outside Magnesium, speaking JSON over HTTP.
import {
  AGENTS_API_PATH,
  AGENTS_MCP_PATH,
  homeItemKey,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import {
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testTicketRoute,
  watchTable,
} from "../testing.ts";

/** An agent outside Magnesium, asking over REST with an operator's session. */
const postTo = (origin: string, path: string, body: unknown, session = "operator") =>
  Effect.promise(() =>
    fetch(`${origin}${AGENTS_API_PATH}${path}`, {
      method: "POST",
      headers: { cookie: `t3_session=${session}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (response) => ({
      status: response.status,
      // A request on success, `{ error }` otherwise.
      body: (await response.json()) as { readonly id: string; readonly error?: string },
    })),
  );

const statusOn = (origin: string, id: string) =>
  Effect.promise(() =>
    fetch(`${origin}${AGENTS_API_PATH}/profile-requests?id=${id}`, {
      headers: { cookie: "t3_session=reader" },
    }).then((response) => response.json() as Promise<{ decision: string | null }>),
  );

const change = {
  name: "scratch-b",
  summary: "Replies end with ok-c",
  files: [{ path: "CLAUDE.md", content: "End every reply with the word `ok-c`.\n" }],
};

describe("an agent asks to change a profile (goal 34, D65)", () => {
  it.live(
    "waits on Home: Reject leaves the profile alone, Approve applies it, and a change that no longer passes stays waiting",
    () =>
      Effect.gen(function* () {
        const server = yield* startTestServer();
        const owner = yield* connect(server.wsUrl("operator"));
        yield* owner[MAGNESIUM_WS_METHODS.profileCreate]({ name: "scratch-b" });
        const needs = yield* watchTable(owner[MAGNESIUM_WS_METHODS.homeNeeds]({}), homeItemKey);

        const post = (path: string, body: unknown, session?: string) =>
          postTo(server.origin, path, body, session);
        const callTool = (name: string, args: unknown) =>
          Effect.promise(() =>
            fetch(`${server.origin}${AGENTS_MCP_PATH}`, {
              method: "POST",
              headers: { cookie: "t3_session=operator", "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name, arguments: args },
              }),
            }).then(
              (response) =>
                response.json() as Promise<{
                  result: { isError: boolean; structuredContent?: { id: string } };
                }>,
            ),
          );
        const status = (id: string) => statusOn(server.origin, id);

        // Asking is a write: a reader can't. A change the check refuses is turned down at once.
        expect((yield* post("/profiles/update", change, "reader")).status).toBe(403);
        const refused = yield* post("/profiles/update", {
          ...change,
          settings: { launchArgs: ["--dangerously-skip-permissions"] },
        });
        expect(refused.status).toBe(400);
        expect(refused.body.error).toContain("The check refuses it");

        const first = yield* post("/profiles/update", change);
        expect(first.body).toMatchObject({
          requestedBy: "An agent outside Magnesium",
          decision: null,
        });
        const firstKey = `@self/profile-request:${first.body.id}`;
        yield* needs.until(() => needs.rows.has(firstKey));
        expect(needs.rows.get(firstKey)).toMatchObject({
          title: "Replies end with ok-c",
          body: {
            _tag: "profile-request",
            kind: "update",
            target: "scratch-b",
            requestedBy: "An agent outside Magnesium",
            preview: expect.stringContaining("+ CLAUDE.md"),
          },
        });

        // Reject: the card goes, the profile stays as it was, and the agent can see why.
        yield* owner[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: firstKey,
          answer: { _tag: "profile-request", requestId: first.body.id, approve: false },
        });
        yield* needs.until(() => !needs.rows.has(firstKey));
        expect((yield* status(first.body.id)).decision).toBe("rejected");
        const untouched = yield* owner[MAGNESIUM_WS_METHODS.profileDetail]({ name: "scratch-b" });
        expect(untouched.version).toBe(1);

        // Asked again over MCP, Approve applies it, in the agent's name and the owner's.
        const second = yield* callTool("update_profile", change);
        expect(second.result.isError).toBe(false);
        const secondId = second.result.structuredContent!.id;
        const secondKey = `@self/profile-request:${secondId}`;
        yield* needs.until(() => needs.rows.has(secondKey));
        yield* owner[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: secondKey,
          answer: { _tag: "profile-request", requestId: secondId, approve: true },
        });
        yield* needs.until(() => !needs.rows.has(secondKey));
        expect((yield* status(secondId)).decision).toBe("approved");
        const applied = yield* owner[MAGNESIUM_WS_METHODS.profileDetail]({ name: "scratch-b" });
        expect(applied.version).toBe(2);
        expect(applied.history[0]).toMatchObject({
          by: "An agent outside Magnesium, approved by you",
          summary: "Replies end with ok-c",
        });
        expect(applied.files.find((file) => file.path === "CLAUDE.md")?.content).toContain("ok-c");

        // A profile made meanwhile: approving its creation is refused, and the ask still waits.
        const create = yield* post("/profiles/create", {
          name: "scratch-c",
          summary: "A second scratch profile",
        });
        const createKey = `@self/profile-request:${create.body.id}`;
        yield* owner[MAGNESIUM_WS_METHODS.profileCreate]({ name: "scratch-c" });
        yield* needs.until(() => needs.rows.has(createKey));
        const stale = yield* owner[MAGNESIUM_WS_METHODS.homeAnswer]({
          key: createKey,
          answer: { _tag: "profile-request", requestId: create.body.id, approve: true },
        }).pipe(Effect.flip);
        expect(stale).toMatchObject({ _tag: "HomeAnswerError" });
        expect((yield* status(create.body.id)).decision).toBe(null);
        expect(needs.rows.has(createKey)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live(
    "an agent on a machine asks there; the hub applies it and the machine marks it decided",
    () =>
      Effect.gen(function* () {
        const machine = yield* startTestServer({
          routes: testTicketRoute("machine-token"),
          ports: {
            environment: Effect.succeed(
              testDescriptor({ environmentId: EnvironmentId.make("env-cpu-host-1") }),
            ),
          },
        });
        const hub = yield* startTestServer({
          files: { [HUB_MACHINES_CONFIG_FILE]: testHubConfig({ "cpu-host-1": machine.origin }) },
          ports: { getSecret: testHubSecrets({ "cpu-host-1": "machine-token" }) },
        });
        const owner = yield* connect(hub.wsUrl("operator"));
        yield* owner[MAGNESIUM_WS_METHODS.profileCreate]({ name: "scratch-b" });
        // The machine holds what the hub pushed, so it leaves the check to the hub.
        yield* owner[MAGNESIUM_WS_METHODS.profileSendNow]({});
        const needs = yield* watchTable(owner[MAGNESIUM_WS_METHODS.homeNeeds]({}), homeItemKey);

        const asked = yield* postTo(machine.origin, "/profiles/update", change);
        expect(asked.status).toBe(200);
        const key = `cpu-host-1/profile-request:${asked.body.id}`;
        yield* needs.until(() => needs.rows.has(key));
        expect(needs.rows.get(key)).toMatchObject({
          machine: { name: "cpu-host-1" },
          body: { _tag: "profile-request", target: "scratch-b" },
        });

        yield* owner[MAGNESIUM_WS_METHODS.homeAnswer]({
          key,
          answer: { _tag: "profile-request", requestId: asked.body.id, approve: true },
        });
        const applied = yield* owner[MAGNESIUM_WS_METHODS.profileDetail]({ name: "scratch-b" });
        expect(applied.history[0]).toMatchObject({
          version: 2,
          by: "An agent outside Magnesium, approved by you",
        });
        expect((yield* statusOn(machine.origin, asked.body.id)).decision).toBe("approved");
        yield* needs.until(() => !needs.rows.has(key));
      }).pipe(Effect.scoped),
  );
});
