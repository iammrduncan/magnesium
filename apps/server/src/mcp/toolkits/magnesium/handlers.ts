// magnesium: Magnesium's profile tools on the per-thread MCP server (goal 34, D65)
import { MagnesiumAgentTools } from "@magnesium/server";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MagnesiumToolkit } from "./tools.ts";

/** Magnesium's refusal, in its own sentence. */
const refusal = (error: { readonly detail: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

const withTools = <A, E>(use: (tools: MagnesiumAgentTools["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* MagnesiumAgentTools);
  });

type Ask = Parameters<MagnesiumAgentTools["Service"]["requestProfileChange"]>[0];

/** Asks the owner on Home, naming the asking thread so the card can say who asked. */
const ask = (input: Ask) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* withTools((tools) =>
      tools
        .requestProfileChange(input, scope.thread?.threadId ?? null)
        .pipe(Effect.mapError(refusal)),
    );
  });

/**
 * Reading is free. Asking changes no profile until the owner approves it on
 * Home, but it is still a write: a read-only client can't ask, and a thread
 * only while its run is live.
 */
export const layer = McpToolAccess.toLayer(MagnesiumToolkit, {
  list_profiles: McpToolAccess.reads(() => withTools((tools) => tools.listProfiles)),
  get_profile: McpToolAccess.reads(({ name }) =>
    withTools((tools) => tools.getProfile(name).pipe(Effect.mapError(refusal))),
  ),
  check_profiles: McpToolAccess.reads(({ names }) =>
    withTools((tools) => tools.checkProfiles(names ?? [])),
  ),
  create_profile: McpToolAccess.writesWithCapability((input) => ask({ kind: "create", ...input })),
  update_profile: McpToolAccess.writesWithCapability((input) => ask({ kind: "update", ...input })),
  delete_profile: McpToolAccess.writesWithCapability((input) => ask({ kind: "delete", ...input })),
  profile_request_status: McpToolAccess.reads(({ id }) =>
    withTools((tools) => tools.profileRequest(id).pipe(Effect.mapError(refusal))),
  ),
  send_profile_now: McpToolAccess.writesWithCapability(() => withTools((tools) => tools.sendNow)),
});
