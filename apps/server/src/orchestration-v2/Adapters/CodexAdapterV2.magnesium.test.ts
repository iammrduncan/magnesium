// magnesium: what Codex is sent at each Magnesium sandbox level (goal 03)
import { isMagnesiumSandboxed } from "@magnesium/server/sandbox";
import { it } from "@effect/vitest";
import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

/** What `turn/start` carries for a level, in a runtime mode. */
const sent = (level: string | undefined, runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const turn = yield* CodexAdapterV2.buildCodexTurnStartParams({
      nativeThreadId: "codex-thread",
      codexInput: [{ type: "text", text: "hostname" }],
      runtimePolicy: { runtimeMode, interactionMode: "default", cwd: null },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      magnesiumSandboxed: isMagnesiumSandboxed(
        level === undefined ? {} : { MAGNESIUM_SANDBOX: level },
      ),
    });
    return {
      sandboxPolicy: turn.sandboxPolicy,
      approvalPolicy: turn.approvalPolicy,
      approvalsReviewer: turn.approvalsReviewer,
    };
  });

describe("Codex under Magnesium's sandboxes", () => {
  it.effect("fenced or in a container: Codex's sandbox is off, and supervised still asks", () =>
    Effect.gen(function* () {
      for (const level of ["fenced", "container"]) {
        expect(yield* sent(level, "approval-required")).toEqual({
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
        });
      }
    }),
  );

  it.effect("native, and an instance Magnesium doesn't run: T3's mapping, unchanged", () =>
    Effect.gen(function* () {
      for (const level of ["native", undefined]) {
        expect(yield* sent(level, "approval-required")).toEqual({
          sandboxPolicy: { type: "readOnly" },
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
        });
        expect((yield* sent(level, "auto-accept-edits")).sandboxPolicy).toEqual({
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
      }
    }),
  );
});
