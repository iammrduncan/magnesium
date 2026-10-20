import {
  type ProfileChange,
  type ProfileCreateInput,
  type ProfileDelivery,
  type ProfileMcpServer,
  type ProfilePushStatus,
  type ProfileServerPermissions,
  type ProfileSummary,
  type ProfileToolPermission,
  MAGNESIUM_WS_METHODS,
  profileInstanceId,
  type ProfileDetail,
} from "@magnesium/contracts";

import { mainInstanceOf } from "./bots.ts";
import { callHub } from "./spokes.ts";

/**
 * Profiles managed from the app (goal 34): calls on the hub's route, and what
 * the Profiles page shows of them. Profiles live on the hub, which delivers
 * them to the machines they name; every change is checked first.
 */

export const listProfilesOnHub = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.listProfiles]({}));

export const profileDetail = (pageUrl: string, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileDetail]({ name }));

export const saveProfile = (pageUrl: string, change: ProfileChange) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileSave](change));

export const createProfile = (pageUrl: string, input: ProfileCreateInput) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileCreate](input));

export const deleteProfile = (pageUrl: string, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileRemove]({ name }));

export const deletedProfiles = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileDeleted]({}));

export const restoreProfile = (pageUrl: string, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileRestore]({ name }));

export const putBackProfile = (pageUrl: string, name: string, version: number) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profilePutBack]({ name, version }));

/** Which of the profile's variables each of its machines has, asked of each by the hub. */
export const profileEnvironment = (pageUrl: string, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileEnvironment]({ name }));

export const sendProfilesNow = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.profileSendNow]({}));

/** The machines a profile goes to, from the hub's pushes: every one it has, or the ones it names. */
const targetsOf = (profile: ProfileSummary, pushes: ReadonlyArray<ProfilePushStatus>) =>
  profile.machines.includes("*")
    ? pushes
    : pushes.filter((push) => profile.machines.includes(push.machine));

/**
 * A profile's line in the list, as the boards write it: its version, then
 * what's wrong ("1 machine behind", "1 machine offline") or where it runs
 * ("3 machines"); a refused profile says so instead.
 */
export const profileListLine = (
  profile: ProfileSummary,
  pushes: ReadonlyArray<ProfilePushStatus>,
  /** The profile whose agent asks to change this one, if one does. */
  askedBy?: string,
): { readonly text: string; readonly tone: "error" | "warning" | "muted" } => {
  const errors = profile.issues.filter((issue) => issue.level === "error").length;
  if (profile.status === "refused") {
    return { text: `Refused · ${errors} ${errors === 1 ? "issue" : "issues"}`, tone: "error" };
  }
  const versioned = (text: string) =>
    profile.version === undefined ? text : `v${profile.version} · ${text}`;
  const machinesText = (count: number, what: string) =>
    `${count} ${count === 1 ? "machine" : "machines"} ${what}`;
  const targets = targetsOf(profile, pushes);
  const refusing = targets.filter((push) => push.refused.includes(profile.name)).length;
  if (refusing > 0) {
    return {
      text: versioned(`${refusing} ${refusing === 1 ? "machine refuses" : "machines refuse"} it`),
      tone: "error",
    };
  }
  if (askedBy !== undefined)
    return { text: versioned(`${askedBy} asks a change`), tone: "warning" };
  const behind = targets.filter((push) => push.error === null && !push.current).length;
  if (behind > 0) return { text: versioned(machinesText(behind, "behind")), tone: "warning" };
  const offline = targets.filter((push) => push.error !== null).length;
  if (offline > 0) return { text: versioned(machinesText(offline, "offline")), tone: "muted" };
  return { text: versioned(describeMachines(profile.machines)), tone: "muted" };
};

export const describeMachines = (machines: ReadonlyArray<string>): string =>
  machines.includes("*")
    ? "Every machine"
    : machines.length === 0
      ? "This hub only"
      : machines.length === 1
        ? machines[0]!
        : `${machines.length} machines`;

const DELIVERY_STATE: Record<
  ProfileDelivery["state"],
  { readonly label: string; readonly tone: "success" | "warning" | "error" | "muted" }
> = {
  current: { label: "Current", tone: "success" },
  behind: { label: "Behind", tone: "warning" },
  refused: { label: "Refused", tone: "error" },
  offline: { label: "Not connected", tone: "muted" },
  "no-access": { label: "No access", tone: "warning" },
};

export const describeDelivery = (delivery: ProfileDelivery) => DELIVERY_STATE[delivery.state];

/** "3 of 4 machines hold v14." */
export const deliveryLine = (deliveries: ReadonlyArray<ProfileDelivery>, version: number) => {
  if (deliveries.length === 0) return "It runs on this hub only.";
  const current = deliveries.filter((delivery) => delivery.state === "current").length;
  return `${current} of ${deliveries.length} ${deliveries.length === 1 ? "machine holds" : "machines hold"} v${version}.`;
};

/** What a server's tools may do, counted: "4 named · 2 allowed · 1 ask · 1 off · the rest ask". */
export const permissionLine = (server: ProfileMcpServer) => {
  const named = Object.values(server.permissions.tools);
  const count = (permission: ProfileToolPermission) =>
    named.filter((value) => value === permission).length;
  const rest = { allow: "the rest run", ask: "the rest ask first", off: "the rest are off" }[
    server.permissions.default
  ];
  return named.length === 0
    ? `Every tool: ${PERMISSION_LABEL[server.permissions.default].toLowerCase()}`
    : `${count("allow")} allowed · ${count("ask")} ask · ${count("off")} off · ${rest}`;
};

export const PERMISSION_LABEL: Record<ProfileToolPermission, string> = {
  allow: "Allow",
  ask: "Ask",
  off: "Off",
};

/** A server's permissions with one tool set. */
export const withToolPermission = (
  permissions: ProfileServerPermissions,
  tool: string,
  permission: ProfileToolPermission,
): ProfileServerPermissions => {
  const tools = { ...permissions.tools, [tool]: permission };
  return { default: permissions.default, tools };
};

/** A profile's `machines` setting: every machine, or the ones picked (D67). */
export const machinesSetting = (every: boolean, picked: ReadonlyArray<string>) =>
  every ? ["*"] : [...picked];

/** Why a new instructions file's name won't do, or undefined when it will. */
export const instructionsFileProblem = (name: string, existing: ReadonlyArray<string>) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) {
    return "A Markdown file: letters, digits, dot, dash or underscore, ending .md.";
  }
  if (existing.includes(name)) return `${name} is already there.`;
  return undefined;
};

/** The files a profile may add, with what each is for, when it hasn't them yet. */
export const KNOWN_INSTRUCTIONS: ReadonlyArray<{ readonly name: string; readonly about: string }> =
  [
    { name: "CLAUDE.md", about: "Claude Code reads it after AGENTS.md" },
    { name: "CONVENTIONS.md", about: "House rules" },
    { name: "MEMORIES.md", about: "Kept between sessions" },
  ];

/** What a profile's name must be, as the hub checks it. */
export const profileNameProblem = (name: string, taken: ReadonlyArray<string>) => {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    return "Start with a-z, then a-z, 0-9 and -, up to 32 characters.";
  }
  if (taken.includes(name)) return `A profile named ${name} exists.`;
  return undefined;
};

/**
 * Where a profile's New thread starts: on the hub when it runs there, else on
 * the first connected machine that holds its current version and has its
 * instance. Null when it runs nowhere a thread can start now.
 */
export function newThreadTarget(input: {
  readonly detail: ProfileDetail;
  readonly machines: ReadonlyArray<{
    readonly name: string | null;
    readonly environmentId: string | null;
    readonly link: string;
  }>;
  /** Whether an environment offers a provider instance. */
  readonly hasInstance: (environmentId: string, instanceId: string) => boolean;
}): { readonly environmentId: string; readonly instanceId: string } | null {
  const { detail, machines, hasInstance } = input;
  const summary = detail.summary;
  const hub = machines.find((machine) => machine.name === null)?.environmentId ?? null;
  const onHub = summary.runsHere ? mainInstanceOf(summary) : undefined;
  if (hub !== null && onHub !== undefined)
    return { environmentId: hub, instanceId: onHub.instanceId };
  // A machine names its instances the same way, at the profile's default level.
  const level =
    summary.harness === "opencode" && summary.sandbox === "container" ? "fenced" : summary.sandbox;
  const instanceId = profileInstanceId(summary.harness, level, summary.name);
  for (const delivery of detail.deliveries) {
    if (delivery.state !== "current") continue;
    const machine = machines.find(
      (candidate) => candidate.name === delivery.machine && candidate.link === "connected",
    );
    if (machine?.environmentId != null && hasInstance(machine.environmentId, instanceId)) {
      return { environmentId: machine.environmentId, instanceId };
    }
  }
  return null;
}
