// magnesium: what Codex is sent at each Magnesium sandbox level (goal 03)
import { it } from "@effect/vitest";
import { ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import { describe, expect } from "vite-plus/test";

import {
  buildTurnStartParams,
  isMagnesiumSandboxed,
  openCodexThread,
} from "./CodexSessionRuntime.ts";

const openResponse = {
  cwd: "/tmp/project",
  model: "gpt-5.3-codex",
  modelProvider: "openai",
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
  sandbox: { type: "danger-full-access" },
  thread: {
    id: "codex-thread",
    createdAt: "2026-10-15T00:00:00.000Z",
    source: { session: "cli" },
    turns: [],
    status: { state: "idle", activeFlags: [] },
  },
} as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];

/** What `thread/start` and `turn/start` carry for a level, in a runtime mode. */
const sent = (level: string | undefined, runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const magnesiumSandboxed = isMagnesiumSandboxed(
      level === undefined ? {} : { MAGNESIUM_SANDBOX: level },
    );
    let start: Record<string, unknown> = {};
    yield* openCodexThread({
      client: {
        request: (_method, params) =>
          Effect.sync(() => {
            start = params as Record<string, unknown>;
            return openResponse;
          }),
        raw: { request: () => Effect.die("no resume here") },
      } as Parameters<typeof openCodexThread>[0]["client"],
      threadId: ThreadId.make("thread-1"),
      runtimeMode,
      cwd: "/tmp/project",
      requestedModel: undefined,
      serviceTier: undefined,
      resumeThreadId: undefined,
      magnesiumSandboxed,
    });
    const turn = yield* buildTurnStartParams({
      threadId: "codex-thread",
      runtimeMode,
      prompt: "hostname",
      magnesiumSandboxed,
    });
    return {
      sandbox: start.sandbox,
      approvalPolicy: start.approvalPolicy,
      approvalsReviewer: start.approvalsReviewer,
      turnSandbox: turn.sandboxPolicy,
      turnApprovalPolicy: turn.approvalPolicy,
    };
  });

describe("Codex under Magnesium's sandboxes", () => {
  it.effect("fenced or in a container: Codex's sandbox is off, and supervised still asks", () =>
    Effect.gen(function* () {
      for (const level of ["fenced", "container"]) {
        expect(yield* sent(level, "approval-required")).toEqual({
          sandbox: "danger-full-access",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          turnSandbox: { type: "dangerFullAccess" },
          turnApprovalPolicy: "untrusted",
        });
      }
    }),
  );

  it.effect("native, and an instance Magnesium doesn't run: T3's mapping, unchanged", () =>
    Effect.gen(function* () {
      for (const level of ["native", undefined]) {
        expect(yield* sent(level, "approval-required")).toEqual({
          sandbox: "read-only",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          turnSandbox: { type: "readOnly" },
          turnApprovalPolicy: "untrusted",
        });
        expect((yield* sent(level, "auto-accept-edits")).turnSandbox).toEqual({
          type: "workspaceWrite",
        });
      }
    }),
  );

  it.effect("keeps every runtime mode's approval policy at every level", () =>
    Effect.gen(function* () {
      for (const mode of [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ] as const) {
        const native = yield* sent("native", mode);
        const fenced = yield* sent("fenced", mode);
        expect(fenced.approvalPolicy).toBe(native.approvalPolicy);
        expect(fenced.approvalsReviewer).toBe(native.approvalsReviewer);
        expect(fenced.turnApprovalPolicy).toBe(native.turnApprovalPolicy);
      }
    }),
  );
});
