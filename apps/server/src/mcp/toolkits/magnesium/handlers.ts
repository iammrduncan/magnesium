// magnesium: Magnesium's profile and Fleet tools on the per-thread MCP server (goals 34, 35; D65, D66)
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
type FleetAsk = Parameters<MagnesiumAgentTools["Service"]["requestFleetChange"]>[0];

/** Asks the owner to change the fleet, on Home, naming the asking thread (goal 35). */
const askFleet = (input: FleetAsk) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* withTools((tools) =>
      tools
        .requestFleetChange(input, scope.thread?.threadId ?? null)
        .pipe(Effect.mapError(refusal)),
    );
  });

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
  list_machines: McpToolAccess.reads(() => withTools((tools) => tools.listMachines)),
  list_backups: McpToolAccess.reads(({ server }) =>
    withTools((tools) => tools.listBackups(server ?? null).pipe(Effect.mapError(refusal))),
  ),
  update_server: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "update", ...input }),
  ),
  rollback_server: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "rollback", ...input }),
  ),
  backup_now: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "backup-now", ...input }),
  ),
  restore_backup: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "restore", ...input }),
  ),
  add_machine: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "add-machine", ...input }),
  ),
  forget_machine: McpToolAccess.writesWithCapability((input) =>
    askFleet({ _tag: "forget-machine", ...input }),
  ),
  edit_pod: McpToolAccess.writesWithCapability((input) => askFleet({ _tag: "edit-pod", ...input })),
  fleet_request_status: McpToolAccess.reads(({ id }) =>
    withTools((tools) => tools.fleetRequest(id).pipe(Effect.mapError(refusal))),
  ),
});
