import {
  parseNativeTwinInstanceId,
  parseProfileInstanceId,
  type ProfileCheckResult,
  type ProfileIssue,
  type ProfileList,
  type ProfilePushStatus,
  type ProfileSummary,
  type SandboxInstance,
  type SandboxLevel,
  type SandboxLevelInfo,
  type SandboxList,
} from "@magnesium/contracts";
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { planProfile } from "./homes.ts";
import {
  checkProfile,
  hasErrors,
  listProfileNames,
  loadProfile,
  type Profile,
  resolveProfile,
  type ResolvedProfile,
} from "./profileFolder.ts";
import type { DetectedSetup } from "./setup.ts";

/** Where this server's profiles live and what it can run them with. */
export class ProfilesConfig extends Context.Service<ProfilesConfig, DetectedSetup>()(
  "@magnesium/server/profiles/catalog/ProfilesConfig",
) {}

/** The provider instances in this server's settings: live in the server, from the file in the CLI. */
export class InstanceSource extends Context.Service<
  InstanceSource,
  { readonly instances: Effect.Effect<ProviderInstanceConfigMap> }
>()("@magnesium/server/profiles/catalog/InstanceSource") {}

/** A machine's folder is the hub's to fill: it holds a `.revision` from the last push. */
export const REVISION_FILE = ".revision";

export interface CatalogEntry {
  readonly profile: Profile;
  readonly resolved: ResolvedProfile;
  readonly issues: ReadonlyArray<ProfileIssue>;
  readonly ready: boolean;
}

export const loadCatalog = Effect.fn("profiles.loadCatalog")(function* (folder: string) {
  const entries: CatalogEntry[] = [];
  for (const name of yield* listProfileNames(folder)) {
    const profile = yield* loadProfile(folder, name);
    const issues = yield* checkProfile(profile);
    entries.push({ profile, resolved: resolveProfile(profile), issues, ready: !hasErrors(issues) });
  }
  return entries;
});

/** Whether the hub fills this folder (a machine), rather than the owner (the hub, a single box). */
export const isPushManaged = Effect.fn("profiles.isPushManaged")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(folder, REVISION_FILE)).pipe(Effect.orElseSucceed(() => false));
});

/**
 * A machine runs every profile the hub pushed it. The hub, or a single box,
 * runs the profiles that name no machines, name it (`hub`), or name `*`.
 */
export const runsHere = (profile: ResolvedProfile, machine: string, pushManaged: boolean) =>
  pushManaged ||
  profile.machines.length === 0 ||
  profile.machines.includes("*") ||
  profile.machines.includes(machine);

export const summarize = (
  path: Path.Path,
  entry: CatalogEntry,
  config: DetectedSetup,
  pushManaged: boolean,
  configured: ProviderInstanceConfigMap = {},
): ProfileSummary => {
  const here = runsHere(entry.resolved, config.machine, pushManaged);
  const plan =
    entry.ready && here
      ? planProfile(path, entry.resolved, config.setup)
      : { instances: [], notes: [] };
  const profile = entry.resolved;
  // What this server runs for it: the instances in its settings, which sync wrote.
  // The CLI reads the same settings, so it never guesses from its own PATH.
  const running = Object.keys(configured).flatMap((instanceId) => {
    const parsed = parseProfileInstanceId(instanceId);
    return parsed?.profile === profile.name
      ? [{ instanceId, harness: parsed.harness, sandbox: parsed.level }]
      : [];
  });
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    avatar: profile.avatar,
    accentColor: profile.accentColor,
    harness: profile.harness,
    sandbox: profile.sandbox,
    machines: profile.machines,
    runsHere: here,
    instances: here ? running : [],
    status: entry.ready ? "ready" : "refused",
    issues: [...entry.issues, ...plan.notes],
  };
};

/** `list_profiles`: every profile here, with what it runs as on this server. */
export const listProfiles = Effect.fn("profiles.listProfiles")(function* (
  pushes: ReadonlyArray<ProfilePushStatus> = [],
) {
  const config = yield* ProfilesConfig;
  const path = yield* Path.Path;
  const entries = yield* loadCatalog(config.folder);
  const pushManaged = yield* isPushManaged(config.folder);
  const configured = yield* (yield* InstanceSource).instances;
  return {
    machine: config.machine,
    folder: config.folder,
    profiles: entries.map((entry) => summarize(path, entry, config, pushManaged, configured)),
    pushes,
  } satisfies ProfileList;
});

/** `check_profiles` (`magnesium-agents check`): refuses what sync and every machine refuse. */
export const checkProfiles = Effect.fn("profiles.checkProfiles")(function* (
  names: ReadonlyArray<string> = [],
) {
  const config = yield* ProfilesConfig;
  const entries = yield* loadCatalog(config.folder);
  const missing = names.filter((name) => !entries.some((entry) => entry.profile.name === name));
  const chosen =
    names.length === 0 ? entries : entries.filter((entry) => names.includes(entry.profile.name));
  const profiles = [
    ...chosen.map((entry) => ({ name: entry.profile.name, issues: entry.issues })),
    ...missing.map((name) => ({
      name,
      issues: [
        { level: "error" as const, file: name, message: `No profile ${name} in ${config.folder}.` },
      ],
    })),
  ];
  return {
    ok: profiles.every((profile) => !hasErrors(profile.issues)),
    profiles,
  } satisfies ProfileCheckResult;
});

const FENCE_NOTES: Record<string, string> = {
  bwrap: "bubblewrap: the state home is hidden, and the agent has its own process view.",
  userns: "A user namespace of its own: the state home is hidden, as with bubblewrap.",
  landlock:
    "Landlock alone: the agent can't create files directly in your home folder, or list it. Install bubblewrap to lift that.",
  seatbelt: "macOS Seatbelt.",
};

/** `list_sandboxes`: the levels this server runs, with why one is missing and how to add it. */
export const listSandboxes = Effect.fn("profiles.listSandboxes")(function* () {
  const config = yield* ProfilesConfig;
  const source = yield* InstanceSource;
  const { fence, container } = config.setup;
  // A pod allows no stronger fence and no containers: say what works there instead.
  const inPod = config.setup.deployment === "pod" || config.setup.deployment === "attached";
  const levels: SandboxLevelInfo[] = [
    "mechanism" in fence
      ? {
          level: "fenced",
          available: true,
          mechanism: fence.mechanism,
          note:
            inPod && fence.mechanism === "landlock"
              ? "Landlock alone, the strongest fence a pod allows: the agent can't create files directly in your home folder, or list it."
              : (FENCE_NOTES[fence.mechanism] ?? null),
          enable: null,
        }
      : {
          level: "fenced",
          available: false,
          mechanism: null,
          note: fence.unavailable,
          enable:
            "Install bubblewrap, or run a Linux kernel with Landlock (5.13 or later) and python3.",
        },
    "image" in container
      ? { level: "container", available: true, mechanism: "podman", note: null, enable: null }
      : {
          level: "container",
          available: false,
          mechanism: null,
          note: container.unavailable,
          enable: inPod
            ? "Run this machine's server on bare metal or in a VM, with rootless Podman, for this level."
            : "Install rootless Podman and set MAGNESIUM_SANDBOX_IMAGE to an image pinned by digest, then restart Magnesium.",
        },
    {
      level: "native",
      available: true,
      mechanism: null,
      note: "No fence: the agent can read Magnesium's own secrets. Choose it per thread only.",
      enable: null,
    },
    {
      level: "microvm",
      available: false,
      mechanism: null,
      note: "Not built yet (goal 19).",
      enable: null,
    },
  ];
  const instances: SandboxInstance[] = [];
  for (const [instanceId, instance] of Object.entries(yield* source.instances)) {
    const profile = parseProfileInstanceId(instanceId);
    if (profile !== null) {
      instances.push({
        instanceId,
        level: profile.level,
        group: `profile:${profile.profile}:${profile.harness}`,
        profile: profile.profile,
      });
      continue;
    }
    const twinOf = parseNativeTwinInstanceId(instanceId);
    const declared = instance.environment?.find(
      (entry) => entry.name === "MAGNESIUM_SANDBOX",
    )?.value;
    instances.push({
      instanceId,
      level: twinOf !== null ? "native" : ((declared as SandboxLevel | undefined) ?? "native"),
      group: twinOf ?? instanceId,
      profile: null,
    });
  }
  return { machine: config.machine, levels, instances } satisfies SandboxList;
});
