import * as Schema from "effect/Schema";

import { HUB_MACHINES_PATH } from "./hub.ts";

/**
 * Magnesium profiles and sandboxes (goal 03; doc 11 "Profiles are provider
 * instances"; D39 to D42). A profile is a folder in dBrain's layout. The hub
 * holds them and pushes each to the machines it names; on a single box the hub
 * is the only machine. Every server's profile sync turns a profile into one
 * provider instance per harness and sandbox level, all sharing the profile's
 * home, so a thread can switch level without losing its session.
 */

/**
 * Any server: the agents API's REST base and its MCP endpoint, for agents and
 * tools. The web UI and the hub use `/api/magnesium/ws` (`MagnesiumRpcGroup`).
 */
export const AGENTS_API_PATH = "/api/magnesium/agents/v1";
export const AGENTS_MCP_PATH = "/api/magnesium/agents/mcp";
/** The hub: a carried machine's sandbox levels, asked of the machine (browsers only talk to the hub). */
export const hubMachineSandboxesPath = (name: string) =>
  `${HUB_MACHINES_PATH}/${encodeURIComponent(name)}/sandboxes`;

/**
 * - `fenced`, the default for every agent Magnesium launches: the agent runs as
 *   the server's user but can't read or write Magnesium's state home (tokens,
 *   secrets, settings, other profiles). Needs nothing installed (D40).
 * - `container`: rootless Podman, where the machine has it; an optional upgrade.
 * - `native`: no fence. Only ever an explicit per-thread choice, like full access.
 * - `microvm`: not built yet (goal 19).
 */
export const SANDBOX_LEVELS = ["fenced", "container", "native", "microvm"] as const;
export const SandboxLevel = Schema.Literals(SANDBOX_LEVELS);
export type SandboxLevel = typeof SandboxLevel.Type;
export const DEFAULT_SANDBOX_LEVEL: SandboxLevel = "fenced";

export const PROFILE_HARNESSES = ["claude", "codex"] as const;
export const ProfileHarness = Schema.Literals(PROFILE_HARNESSES);
export type ProfileHarness = typeof ProfileHarness.Type;

/** Lowercase, so instance ids parse back without ambiguity. */
export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const ProfileName = Schema.String.check(Schema.isPattern(PROFILE_NAME_PATTERN));
export type ProfileName = typeof ProfileName.Type;

const PROFILE_INSTANCE_PREFIX = "mg";

/** `mg-<harness>-<level>-<profile>`: unique, and readable by any client without a lookup. */
export const profileInstanceId = (
  harness: ProfileHarness,
  level: SandboxLevel,
  profile: string,
): string => `${PROFILE_INSTANCE_PREFIX}-${harness}-${level}-${profile}`;

export interface ProfileInstanceRef {
  readonly harness: ProfileHarness;
  readonly level: SandboxLevel;
  readonly profile: string;
}

export const parseProfileInstanceId = (instanceId: string): ProfileInstanceRef | null => {
  const [prefix, harness, level, ...rest] = instanceId.split("-");
  const profile = rest.join("-");
  if (
    prefix !== PROFILE_INSTANCE_PREFIX ||
    !PROFILE_HARNESSES.includes(harness as ProfileHarness) ||
    !SANDBOX_LEVELS.includes(level as SandboxLevel) ||
    !PROFILE_NAME_PATTERN.test(profile)
  ) {
    return null;
  }
  return { harness: harness as ProfileHarness, level: level as SandboxLevel, profile };
};

/** The unfenced twin of a stock instance (`codex`, `claudeAgent`, ...), for a per-thread choice. */
export const nativeTwinInstanceId = (instanceId: string): string => `mg_native_${instanceId}`;
export const parseNativeTwinInstanceId = (instanceId: string): string | null =>
  instanceId.startsWith("mg_native_") ? instanceId.slice("mg_native_".length) || null : null;

/** Every instance profile sync writes, which it may replace or remove. */
export const isManagedInstanceId = (instanceId: string): boolean =>
  parseProfileInstanceId(instanceId) !== null || parseNativeTwinInstanceId(instanceId) !== null;

export const ProfileIssue = Schema.Struct({
  level: Schema.Literals(["error", "warn"]),
  /** The file in the profile folder the issue is about. */
  file: Schema.String,
  message: Schema.String,
});
export type ProfileIssue = typeof ProfileIssue.Type;

export const ProfileInstance = Schema.Struct({
  instanceId: Schema.String,
  harness: ProfileHarness,
  sandbox: SandboxLevel,
});
export type ProfileInstance = typeof ProfileInstance.Type;

export const ProfileSummary = Schema.Struct({
  name: ProfileName,
  displayName: Schema.String,
  description: Schema.String,
  /** Initials shown in the picker. */
  avatar: Schema.String,
  /** `#rrggbb`. */
  accentColor: Schema.String,
  harness: ProfileHarness,
  /** Its default level: `fenced` or `container`, never `native`. */
  sandbox: SandboxLevel,
  /** Machine names the hub pushes it to; `*` is every machine. Empty: this box only. */
  machines: Schema.Array(Schema.String),
  /** Whether this server runs it. */
  runsHere: Schema.Boolean,
  /** The provider instances this server runs it as. */
  instances: Schema.Array(ProfileInstance),
  /** `refused` profiles have errors: sync and every machine refuse them. */
  status: Schema.Literals(["ready", "refused"]),
  issues: Schema.Array(ProfileIssue),
});
export type ProfileSummary = typeof ProfileSummary.Type;

export const ProfilePushStatus = Schema.Struct({
  machine: Schema.String,
  /** The revision the machine holds, when the hub last looked. */
  revision: Schema.NullOr(Schema.String),
  /** ISO time of the last push or check. */
  checkedAt: Schema.NullOr(Schema.String),
  /** Why the last push failed, if it did. */
  error: Schema.NullOr(Schema.String),
  refused: Schema.Array(Schema.String),
});
export type ProfilePushStatus = typeof ProfilePushStatus.Type;

export const ProfileList = Schema.Struct({
  /** This server's name among the fleet (`hub` on the hub and on a single box). */
  machine: Schema.String,
  /** Where this server reads profiles from. */
  folder: Schema.String,
  profiles: Schema.Array(ProfileSummary),
  /** On the hub: what it last pushed to each machine. */
  pushes: Schema.Array(ProfilePushStatus),
});
export type ProfileList = typeof ProfileList.Type;

export const ProfileCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  profiles: Schema.Array(
    Schema.Struct({ name: Schema.String, issues: Schema.Array(ProfileIssue) }),
  ),
});
export type ProfileCheckResult = typeof ProfileCheckResult.Type;

export const SandboxLevelInfo = Schema.Struct({
  level: SandboxLevel,
  available: Schema.Boolean,
  /** What enforces it here: `bwrap`, `landlock`, `seatbelt` or `podman`. */
  mechanism: Schema.NullOr(Schema.String),
  /** One line: why it is unavailable, or what to know about it. */
  note: Schema.NullOr(Schema.String),
  /** One line: how to make it available. */
  enable: Schema.NullOr(Schema.String),
});
export type SandboxLevelInfo = typeof SandboxLevelInfo.Type;

export const SandboxInstance = Schema.Struct({
  instanceId: Schema.String,
  level: SandboxLevel,
  /** Instances sharing one home; a thread can switch between them. */
  group: Schema.String,
  /** The profile it runs, or null for a stock instance. */
  profile: Schema.NullOr(ProfileName),
});
export type SandboxInstance = typeof SandboxInstance.Type;

/** `list_sandboxes`: the levels this server can run, and the level of each agent instance. */
export const SandboxList = Schema.Struct({
  machine: Schema.String,
  levels: Schema.Array(SandboxLevelInfo),
  instances: Schema.Array(SandboxInstance),
});
export type SandboxList = typeof SandboxList.Type;

/** One file of a profile folder, by its path inside the folder. */
export const ProfileFile = Schema.Struct({
  path: Schema.String,
  contentBase64: Schema.String,
  executable: Schema.optionalKey(Schema.Boolean),
});
export type ProfileFile = typeof ProfileFile.Type;

export const ProfileBundle = Schema.Struct({
  name: ProfileName,
  files: Schema.Array(ProfileFile),
});
export type ProfileBundle = typeof ProfileBundle.Type;

/** The full set of profiles a machine should hold. Profiles it holds that are not here go. */
export const ProfilePush = Schema.Struct({
  revision: Schema.String,
  profiles: Schema.Array(ProfileBundle),
});
export type ProfilePush = typeof ProfilePush.Type;

export const ProfilePushResult = Schema.Struct({
  revision: Schema.String,
  accepted: Schema.Array(Schema.String),
  /** Refused profiles keep their last good copy on the machine. */
  refused: Schema.Array(Schema.Struct({ name: Schema.String, issues: Schema.Array(ProfileIssue) })),
  removed: Schema.Array(Schema.String),
});
export type ProfilePushResult = typeof ProfilePushResult.Type;

export const ProfileRevision = Schema.Struct({ revision: Schema.NullOr(Schema.String) });
export type ProfileRevision = typeof ProfileRevision.Type;
