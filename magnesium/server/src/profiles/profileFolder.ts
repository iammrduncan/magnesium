import {
  DEFAULT_SANDBOX_LEVEL,
  PROFILE_HARNESSES,
  PROFILE_NAME_PATTERN,
  type ProfileHarness,
  type ProfileIssue,
  SANDBOX_LEVELS,
  type SandboxLevel,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { parse as parseYaml } from "yaml";

/**
 * A profile is a folder in the profile folder layout (D37):
 * `profile.yaml` and `AGENTS.md` are required; `CLAUDE.md`, `CONVENTIONS.md`,
 * `MEMORIES.md`, `mcp.json`, `hooks.json` and `skills/<name>/SKILL.md` are optional.
 * Magnesium adds `display_name`, `accent`, `machines`, `harnesses` and
 * `launch_args`, and `sandbox.level` is `fenced` (the default) or `container`.
 * Generated state lives in the folder's `.magnesium/`.
 */

export const FILES = {
  meta: "profile.yaml",
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  conventions: "CONVENTIONS.md",
  memories: "MEMORIES.md",
  mcp: "mcp.json",
  hooks: "hooks.json",
  skills: "skills",
} as const;

/** Inside each profile folder: homes, launch settings and logs, never pushed. */
export const STATE_DIR = ".magnesium";

const Mount = Schema.Struct({ path: Schema.String, mode: Schema.optionalKey(Schema.String) });

const ProfileMeta = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  display_name: Schema.optionalKey(Schema.String),
  accent: Schema.optionalKey(Schema.String),
  machines: Schema.optionalKey(Schema.Array(Schema.String)),
  harness: Schema.optionalKey(Schema.String),
  harnesses: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A command-line string, or a YAML list with one argument per item. */
  launch_args: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  native_memory: Schema.optionalKey(Schema.Boolean),
  sandbox: Schema.optionalKey(
    Schema.Struct({
      level: Schema.optionalKey(Schema.String),
      image: Schema.optionalKey(Schema.String),
      network: Schema.optionalKey(Schema.String),
      mounts: Schema.optionalKey(Schema.Array(Mount)),
      secrets: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type ProfileMeta = typeof ProfileMeta.Type;
const decodeMeta = Schema.decodeUnknownEffect(ProfileMeta);

const McpFile = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
);
const HooksFile = Schema.fromJsonString(
  Schema.Struct({ hooks: Schema.Record(Schema.String, Schema.Unknown) }),
);
export const decodeMcpFile = Schema.decodeUnknownEffect(McpFile);
export const decodeHooksFile = Schema.decodeUnknownEffect(HooksFile);

export interface Profile {
  readonly name: string;
  readonly dir: string;
  readonly meta: ProfileMeta;
  /** profile.yaml's top-level keys, to refuse ones a profile may not set. */
  readonly keys: ReadonlyArray<string>;
  /** Set when profile.yaml did not parse; `meta` is then empty. */
  readonly parseError: string | undefined;
}

/** What sync and the picker use, with defaults filled in. */
export interface ResolvedProfile {
  readonly name: string;
  readonly dir: string;
  readonly displayName: string;
  readonly description: string;
  readonly avatar: string;
  readonly accentColor: string;
  readonly harness: ProfileHarness;
  readonly harnesses: ReadonlyArray<ProfileHarness>;
  /** Its default level: `fenced` or `container`. `native` is only ever chosen per thread. */
  readonly sandbox: SandboxLevel;
  readonly machines: ReadonlyArray<string>;
  /** Environment variable names passed into a sandbox, never values. */
  readonly passEnv: ReadonlyArray<string>;
  /** One argument per item, whichever form profile.yaml used. */
  readonly launchArgs: ReadonlyArray<string>;
  readonly nativeMemory: boolean;
  readonly image: string | undefined;
  readonly network: "internet" | "none";
  readonly mounts: ReadonlyArray<{ readonly path: string; readonly mode: "ro" | "rw" }>;
}

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const MACHINE_PATTERN = /^(\*|[a-z0-9][a-z0-9-]{0,62})$/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** The secrets check: a literal token or key in a JSON file instead of `${VAR}`. */
const SECRET_LITERAL =
  /["\s](sk-|ghp_|gho_|github_pat_|xox[bp]-|eyJ)[A-Za-z0-9_-]{8,}|Bearer (?!\$\{)[A-Za-z0-9._~+/-]{16,}/;

/** Accents for profiles that name none, picked by name so a profile keeps its colour. */
const ACCENTS = ["#2f80ed", "#c2410c", "#0f766e", "#7c3aed", "#b45309", "#be123c", "#15803d"];

/** Same rule as the picker's initials (`providerInstanceInitials`), so both agree. */
export const profileInitials = (label: string): string => {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
};

const accentFor = (name: string) => {
  let sum = 0;
  for (const char of name) sum = (sum * 31 + char.charCodeAt(0)) % 9973;
  return ACCENTS[sum % ACCENTS.length]!;
};

const isHarness = (value: string): value is ProfileHarness =>
  PROFILE_HARNESSES.includes(value as ProfileHarness);
const isLevel = (value: string): value is SandboxLevel =>
  SANDBOX_LEVELS.includes(value as SandboxLevel);

/** Profile folders under `root`: named like a profile, holding a profile.yaml. */
export const listProfileNames = Effect.fn("profiles.listProfileNames")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]));
  const names: string[] = [];
  for (const entry of entries.toSorted()) {
    if (!PROFILE_NAME_PATTERN.test(entry)) continue;
    if (
      yield* fs.exists(path.join(root, entry, FILES.meta)).pipe(Effect.orElseSucceed(() => false))
    )
      names.push(entry);
  }
  return names;
});

export const readOptional = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined)),
  );

export const loadProfile = Effect.fn("profiles.loadProfile")(function* (
  root: string,
  name: string,
) {
  const path = yield* Path.Path;
  const dir = path.join(root, name);
  const text = (yield* readOptional(path.join(dir, FILES.meta))) ?? "";
  const parsed = yield* Effect.try({
    try: () => parseYaml(text) as unknown,
    catch: (cause) => String(cause),
  }).pipe(Effect.result);
  if (parsed._tag === "Failure") {
    return { name, dir, meta: {}, keys: [], parseError: parsed.failure } satisfies Profile;
  }
  const raw = parsed.success ?? {};
  const keys = Predicate.isObject(raw) ? Object.keys(raw) : [];
  const meta = yield* decodeMeta(raw).pipe(Effect.result);
  return meta._tag === "Success"
    ? ({ name, dir, meta: meta.success, keys, parseError: undefined } satisfies Profile)
    : ({ name, dir, meta: {}, keys, parseError: meta.failure.message } satisfies Profile);
});

export const resolveProfile = (profile: Profile): ResolvedProfile => {
  const meta = profile.meta;
  const displayName = meta.display_name?.trim() || profile.name;
  const harness = meta.harness && isHarness(meta.harness) ? meta.harness : "claude";
  const harnesses = [harness, ...(meta.harnesses ?? []).filter(isHarness)].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  const level = meta.sandbox?.level === "container" ? "container" : DEFAULT_SANDBOX_LEVEL;
  const passEnv = [...(meta.env ?? []), ...(meta.sandbox?.secrets ?? [])].filter(
    (value, index, all) => ENV_NAME_PATTERN.test(value) && all.indexOf(value) === index,
  );
  return {
    name: profile.name,
    dir: profile.dir,
    displayName,
    description: meta.description?.trim() ?? "",
    avatar: profileInitials(displayName),
    accentColor:
      meta.accent && ACCENT_PATTERN.test(meta.accent) ? meta.accent : accentFor(profile.name),
    harness,
    harnesses,
    sandbox: level,
    machines: meta.machines ?? [],
    passEnv,
    launchArgs: launchArgList(meta.launch_args),
    nativeMemory: meta.native_memory ?? false,
    image: meta.sandbox?.image?.trim() || undefined,
    network: meta.sandbox?.network === "none" ? "none" : "internet",
    mounts: (meta.sandbox?.mounts ?? []).map((mount) => ({
      path: mount.path,
      mode: mount.mode === "rw" ? "rw" : "ro",
    })),
  };
};

/**
 * `launch_args` as a list, one argument per item: a string is split the way T3
 * splits an instance's launch args (quotes kept together); a list is taken as is.
 */
export const launchArgList = (value: string | ReadonlyArray<string> | undefined): string[] =>
  value === undefined
    ? []
    : typeof value === "string"
      ? [...tokenizeCliArgs(value)]
      : value.filter((arg) => arg.length > 0);

const PLAIN_ARG = /^[\w@%+=:,./-]+$/;

/** The list back as the one string a provider instance takes, quoted so T3 splits it the same way. */
export const joinLaunchArgs = (args: ReadonlyArray<string>): string =>
  args
    .map((arg) =>
      PLAIN_ARG.test(arg) ? arg : `"${arg.replace(/["\\$`]/g, (char) => `\\${char}`)}"`,
    )
    .join(" ");

/**
 * Flags that would decide a thread's permissions, its sandbox, or the settings
 * and MCP servers sync writes. T3 folds `--permission-mode` and
 * `--dangerously-skip-permissions` into every thread's mode (doc 08 section 4),
 * so one profile could run every thread with full access.
 */
const REFUSED_FLAGS = new Map<string, string>([
  ["--permission-mode", "permission modes are chosen per thread"],
  ["--dangerously-skip-permissions", "full access is a per-thread choice, never a profile setting"],
  [
    "--allow-dangerously-skip-permissions",
    "full access is a per-thread choice, never a profile setting",
  ],
  [
    "--dangerously-bypass-approvals-and-sandbox",
    "full access is a per-thread choice, never a profile setting",
  ],
  ["--yolo", "full access is a per-thread choice, never a profile setting"],
  ["--full-auto", "approvals are chosen per thread"],
  ["--ask-for-approval", "approvals are chosen per thread"],
  ["-a", "approvals are chosen per thread"],
  ["--sandbox", "the sandbox comes from sandbox.level"],
  ["-s", "the sandbox comes from sandbox.level"],
  ["--settings", "settings come from the profile's folder"],
  ["--mcp-config", "MCP servers come from the profile's mcp.json"],
  ["--strict-mcp-config", "MCP servers come from the profile's mcp.json"],
]);
const CONFIG_FLAGS = new Set(["-c", "--config"]);
const REFUSED_CONFIG_KEY = /approval|sandbox|permission|bypass|trust/i;

export const refusedLaunchArgs = (launchArgs: string | ReadonlyArray<string>): string[] => {
  // Each item is split again too, so "--permission-mode plan" as one item is caught.
  const tokens = launchArgList(launchArgs).flatMap((arg) => [...tokenizeCliArgs(arg)]);
  const messages: string[] = [];
  tokens.forEach((token, index) => {
    const [flag, inline] = token.split(/=(.*)/s, 2) as [string, string | undefined];
    const reason = REFUSED_FLAGS.get(flag);
    if (reason !== undefined) {
      messages.push(`${flag} is refused: ${reason}.`);
      return;
    }
    if (CONFIG_FLAGS.has(flag)) {
      const value = inline ?? tokens[index + 1] ?? "";
      if (REFUSED_CONFIG_KEY.test(value.split("=")[0] ?? "")) {
        messages.push(
          `${flag} ${value.split("=")[0]} is refused: approvals and sandboxes are chosen per thread.`,
        );
      }
    }
  });
  return messages;
};

/** Keys a profile may never set: the binary, the home and the permission mode are Magnesium's. */
const REFUSED_KEYS = new Map<string, string>([
  ["permission_mode", "permission modes are chosen per thread"],
  ["runtime_mode", "permission modes are chosen per thread"],
  ["permissions", "permission modes are chosen per thread"],
  ["binary", "the wrapper is the only binary"],
  ["binary_path", "the wrapper is the only binary"],
  ["home", "a profile's home is always its folder's .magnesium"],
  ["home_path", "a profile's home is always its folder's .magnesium"],
]);

/** Mounts that would hand a sandbox the keys to the machine. */
const REFUSED_MOUNT =
  /^(\/|~|~\/?\.(ssh|magnesium|config|gnupg|aws)(\/.*)?|.*(docker|podman)\.sock.*)$/;

/** Validate one profile folder without running anything. Errors refuse the profile. */
export const checkProfile = Effect.fn("profiles.checkProfile")(function* (profile: Profile) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issues: ProfileIssue[] = [];
  const add = (level: ProfileIssue["level"], file: string, message: string) =>
    issues.push({ level, file, message });
  const file = (name: string) => path.join(profile.dir, name);

  if (!PROFILE_NAME_PATTERN.test(profile.name)) {
    add("error", FILES.meta, `The folder name must match ${PROFILE_NAME_PATTERN}.`);
  }
  if (profile.parseError !== undefined) {
    add("error", FILES.meta, `Could not read it: ${profile.parseError}`);
    return issues;
  }
  const meta = profile.meta;
  if (meta.name !== undefined && meta.name !== profile.name) {
    add("error", FILES.meta, `name is "${meta.name}" but the folder is "${profile.name}".`);
  }
  for (const key of profile.keys) {
    const reason = REFUSED_KEYS.get(key);
    if (reason !== undefined) add("error", FILES.meta, `${key} is refused: ${reason}.`);
  }
  for (const message of refusedLaunchArgs(meta.launch_args ?? "")) {
    add("error", FILES.meta, `launch_args: ${message}`);
  }
  for (const value of [meta.harness, ...(meta.harnesses ?? [])]) {
    if (value !== undefined && !isHarness(value)) {
      add(
        "error",
        FILES.meta,
        `Harness "${value}" must be one of ${PROFILE_HARNESSES.join(", ")}.`,
      );
    }
  }
  const sandbox = meta.sandbox ?? {};
  if (sandbox.level === "native") {
    add(
      "error",
      FILES.meta,
      "sandbox.level native is refused: no fence is only ever chosen per thread, never as a default.",
    );
  } else if (sandbox.level === "microvm") {
    add("error", FILES.meta, "The microvm sandbox is not built yet (goal 19).");
  } else if (sandbox.level !== undefined && !isLevel(sandbox.level)) {
    add("error", FILES.meta, `sandbox.level must be fenced or container, not "${sandbox.level}".`);
  }
  if (sandbox.network !== undefined && !["internet", "none", "open"].includes(sandbox.network)) {
    add("error", FILES.meta, "sandbox.network must be internet or none.");
  }
  if (sandbox.image !== undefined && !sandbox.image.includes("@sha256:")) {
    add("error", FILES.meta, "sandbox.image must be pinned by digest (name@sha256:...).");
  }
  for (const mount of sandbox.mounts ?? []) {
    if (!(mount.path.startsWith("/") || mount.path.startsWith("~"))) {
      add("error", FILES.meta, `Mount ${mount.path} must be an absolute path.`);
    } else if (REFUSED_MOUNT.test(mount.path.replace(/\/+$/, "") || "/")) {
      add("error", FILES.meta, `Mount ${mount.path} is refused: it would expose the machine.`);
    }
    if (mount.mode !== undefined && mount.mode !== "ro" && mount.mode !== "rw") {
      add("error", FILES.meta, `Mount ${mount.path}: mode must be ro or rw.`);
    }
  }
  for (const name of [...(meta.env ?? []), ...(sandbox.secrets ?? [])]) {
    if (!ENV_NAME_PATTERN.test(name)) {
      add("error", FILES.meta, `"${name}" is not an environment variable name; list names only.`);
    }
  }
  for (const machine of meta.machines ?? []) {
    if (!MACHINE_PATTERN.test(machine))
      add("error", FILES.meta, `"${machine}" is not a machine name.`);
  }
  if (meta.accent !== undefined && !ACCENT_PATTERN.test(meta.accent)) {
    add("error", FILES.meta, "accent must be a colour like #2f80ed.");
  }
  if (!(yield* fs.exists(file(FILES.agents)).pipe(Effect.orElseSucceed(() => false)))) {
    add("error", FILES.agents, "Missing; it holds the agent's role and rules.");
  }
  const mcp = yield* readOptional(file(FILES.mcp));
  if (mcp !== undefined) {
    const decoded = yield* decodeMcpFile(mcp).pipe(Effect.result);
    if (decoded._tag === "Failure") add("error", FILES.mcp, "Needs an mcpServers object.");
    if (SECRET_LITERAL.test(mcp)) {
      add("error", FILES.mcp, "Looks like it holds a secret; write ${VAR} and pass VAR by name.");
    }
  }
  const hooks = yield* readOptional(file(FILES.hooks));
  if (hooks !== undefined) {
    const decoded = yield* decodeHooksFile(hooks).pipe(Effect.result);
    if (decoded._tag === "Failure") add("error", FILES.hooks, "Needs a hooks object.");
    if (SECRET_LITERAL.test(hooks)) {
      add("error", FILES.hooks, "Looks like it holds a secret; pass it by name.");
    }
  }
  const skills = yield* fs.readDirectory(file(FILES.skills)).pipe(Effect.orElseSucceed(() => []));
  for (const skill of skills) {
    const hasSkill = yield* fs
      .exists(path.join(file(FILES.skills), skill, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasSkill) add("warn", `${FILES.skills}/${skill}`, "No SKILL.md.");
  }
  return issues;
});

export const hasErrors = (issues: ReadonlyArray<ProfileIssue>) =>
  issues.some((issue) => issue.level === "error");
