import {
  type EnvironmentThreadShell,
  presentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";

/**
 * A server's own thread as the sidebar reads it (Orchestrator V2): what it
 * waits on, its latest run and runtime, with ISO times. Home and the status
 * counts read threads through this, so they follow the sidebar's rules.
 */
export type ThreadView = EnvironmentThreadShell;

/** The environment id is not read: a view never leaves the server it describes. */
const LOCAL = EnvironmentId.make("local");

export const viewOf = (shell: OrchestrationV2ThreadShell): ThreadView =>
  presentThreadShell(LOCAL, shell);

/** Working on a run, or holding for background work it started. */
export const isBusy = (view: ThreadView): boolean =>
  threadRuntimeIsActive(view.runtime) || view.runtime?.status === "idle";

/** A subagent's thread, which the sidebar folds under its parent. */
export const isSubagent = (view: ThreadView): boolean =>
  view.lineage.relationshipToParent === "subagent";
