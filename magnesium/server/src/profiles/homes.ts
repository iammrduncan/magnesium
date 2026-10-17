import {
  type ProfileHarness,
  type ProfileIssue,
  profileInstanceId,
  type SandboxLevel,
  type ServerDeployment,
} from "@magnesium/contracts";
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  decodeHooksFile,
  decodeMcpFile,
  FILES,
  joinLaunchArgs,
  readOptional,
  type ResolvedProfile,
  STATE_DIR,
} from "./profileFolder.ts";

/**
 * What a profile becomes on one server: a home per harness under the profile's
 * `.magnesium/` (the harness's CLAUDE_CONFIG_DIR or CODEX_HOME), the launch
 * settings the wrapper reads, and one provider instance per harness and sandbox
 * level. Every level of a harness shares one home, so T3 lets a thread switch
 * between them (its continuation key is the home).
 */

export interface MachineSetup {
  /** Magnesium's state home (T3CODE_HOME): what the fence hides. */
  readonly stateHome: string;
  /** Where `magnesium-claude`, `magnesium-codex` and `magnesium-fenced` live. */
  readonly wrapperDir: string | undefined;
  /** The real CLIs, as found on the server's PATH. A harness that is missing gets no instance. */
  readonly binaries: Readonly<Record<ProfileHarness | "opencode", string | undefined>>;
  /** Paths a fenced agent may read but never change: the install, its unit and env file. */
  readonly protect: ReadonlyArray<string>;
  /** The account's home, for the machine's own logins. */
  readonly userHome: string;
  /** The port this server listens on, when known: a container agent reaches T3's MCP tools through it. */
  readonly serverPort?: number | undefined;
  /** What fences agents here (`bwrap`, `landlock`, `seatbelt`), or why nothing can. */
  readonly fence: { readonly mechanism: string } | { readonly unavailable: string };
  /** Rootless Podman with an image, or why not. */
  readonly container: { readonly image: string } | { readonly unavailable: string };
  /** How this server is deployed. In a pod, neither a stronger fence nor containers can be added. */
  readonly deployment?: ServerDeployment | null | undefined;
  /**
   * False on a gateway (goal 25): it holds its namespace's deploy identity, so
   * no agent may run beside it and every provider is turned off.
   */
  readonly runsAgents?: boolean | undefined;
}

export interface PlannedInstance {
  readonly instanceId: ProviderInstanceId;
  readonly harness: ProfileHarness;
  readonly sandbox: SandboxLevel;
  readonly config: ProviderInstanceConfig;
}

export interface ProfilePlan {
  readonly instances: ReadonlyArray<PlannedInstance>;
  /** Why some harness or level does not run here. */
  readonly notes: ReadonlyArray<ProfileIssue>;
}

const DRIVERS: Record<ProfileHarness, string> = { claude: "claudeAgent", codex: "codex" };

export const stateDirOf = (path: Path.Path, profile: ResolvedProfile) =>
  path.join(profile.dir, STATE_DIR);

/** The levels a profile runs at here: its default first, then native, then container if offered. */
export const levelsFor = (profile: ResolvedProfile, setup: MachineSetup): SandboxLevel[] => {
  const containerReady = "image" in setup.container;
  const levels: SandboxLevel[] = [profile.sandbox, "fenced", "native"];
  if (containerReady) levels.push("container");
  return levels.filter((level, index, all) => all.indexOf(level) === index);
};

export const planProfile = (
  path: Path.Path,
  profile: ResolvedProfile,
  setup: MachineSetup,
): ProfilePlan => {
  const notes: ProfileIssue[] = [];
  const instances: PlannedInstance[] = [];
  if (setup.wrapperDir === undefined) {
    notes.push({ level: "warn", file: FILES.meta, message: "This server has no wrapper folder." });
    return { instances, notes };
  }
  if (profile.sandbox === "container" && "unavailable" in setup.container) {
    notes.push({
      level: "warn",
      file: FILES.meta,
      message: `Its default sandbox is container, which is unavailable here (${setup.container.unavailable}).`,
    });
  }
  const state = stateDirOf(path, profile);
  for (const harness of profile.harnesses) {
    if (setup.binaries[harness] === undefined) {
      notes.push({ level: "warn", file: FILES.meta, message: `${harness} is not installed here.` });
      continue;
    }
    for (const sandbox of levelsFor(profile, setup)) {
      instances.push({
        instanceId: ProviderInstanceId.make(profileInstanceId(harness, sandbox, profile.name)),
        harness,
        sandbox,
        config: {
          driver: ProviderDriverKind.make(DRIVERS[harness]),
          displayName:
            sandbox === profile.sandbox
              ? profile.displayName
              : `${profile.displayName} · ${sandbox}`,
          accentColor: profile.accentColor,
          // Names the wrapper reads; never secrets. Secrets pass by name in launch.env.
          environment: [
            { name: "MAGNESIUM_PROFILE", value: profile.name, sensitive: false },
            { name: "MAGNESIUM_SANDBOX", value: sandbox, sensitive: false },
          ],
          enabled: true,
          config: {
            binaryPath: path.join(setup.wrapperDir, `magnesium-${harness}`),
            homePath: path.join(state, harness),
            launchArgs: joinLaunchArgs(profile.launchArgs),
          },
        },
      });
    }
  }
  return { instances, notes };
};

const section = (title: string, text: string | undefined) =>
  text?.trim() ? `\n## ${title}\n\n${text.trim()}\n` : "";

/** The instructions both harnesses read from their home (CLAUDE.md, AGENTS.md). */
export const renderInstructions = Effect.fn("profiles.renderInstructions")(function* (
  profile: ResolvedProfile,
) {
  const path = yield* Path.Path;
  const read = (name: string) => readOptional(path.join(profile.dir, name));
  const about = profile.description ? `: ${profile.description.replace(/[.!?]\s*$/, "")}` : "";
  return [
    `# Magnesium profile: ${profile.displayName}`,
    "",
    `You are the agent "${profile.name}"${about}.`,
    `Your profile folder is ${profile.dir}. Magnesium manages it; treat it as read-only.`,
    "The project's own instructions (its AGENTS.md or CLAUDE.md) still apply to work in the project.",
    section(`Role and rules (${FILES.agents})`, yield* read(FILES.agents)) +
      section(`Rules (${FILES.claude})`, yield* read(FILES.claude)) +
      section(`Conventions (${FILES.conventions})`, yield* read(FILES.conventions)) +
      section(`What you remember (${FILES.memories})`, yield* read(FILES.memories)) +
      section(
        "Memory",
        "Save what will matter in a later session through your knowledge-base tools, if you have them, never in the profile folder. Never write secrets.",
      ),
  ].join("\n");
});

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `launch.env`, sourced by the wrapper. Paths and names only; never a secret value. */
export const renderLaunchEnv = (
  path: Path.Path,
  profile: ResolvedProfile,
  setup: MachineSetup,
): string => {
  const state = stateDirOf(path, profile);
  const expand = (value: string) =>
    value === "~"
      ? setup.userHome
      : value.startsWith("~/")
        ? path.join(setup.userHome, value.slice(2))
        : value;
  const values: Record<string, string> = {
    MG_PROFILE: profile.name,
    MG_PROFILE_DIR: profile.dir,
    MG_STATE_DIR: state,
    MG_STATE_HOME: setup.stateHome,
    MG_FENCE: "mechanism" in setup.fence ? setup.fence.mechanism : "",
    MG_PROTECT: setup.protect.join(":"),
    MG_CONTAINER_HOME: path.join(state, "home"),
    MG_IMAGE: profile.image ?? ("image" in setup.container ? setup.container.image : ""),
    MG_NETWORK: profile.network,
    MG_SERVER_PORT: setup.serverPort === undefined ? "" : String(setup.serverPort),
    MG_PASS_ENV: profile.passEnv.join(" "),
    MG_MOUNTS: profile.mounts.map((mount) => `${expand(mount.path)}:${mount.mode}`).join("\n"),
    MG_CLAUDE_BIN: setup.binaries.claude ?? "",
    MG_CODEX_BIN: setup.binaries.codex ?? "",
  };
  return [
    "# Written by Magnesium's profile sync for the wrapper. Paths and names only, never secrets.",
    ...Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`),
    "",
  ].join("\n");
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const prettyJson = (value: unknown) => `${encodePrettyJson(value)}\n`;

const claudeSettings = Effect.fn("profiles.claudeSettings")(function* (profile: ResolvedProfile) {
  const path = yield* Path.Path;
  const hooksText = yield* readOptional(path.join(profile.dir, FILES.hooks));
  const hooks =
    hooksText === undefined
      ? undefined
      : yield* decodeHooksFile(hooksText).pipe(
          Effect.map((decoded) => decoded.hooks),
          Effect.orElseSucceed(() => undefined),
        );
  return {
    ...(hooks && Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(profile.nativeMemory ? {} : { autoMemoryEnabled: false }),
  };
});

const tomlString = (value: string) => encodeJson(value);
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));
const VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * mcp.json as Codex `[mcp_servers]` tables. Codex has no `${VAR}`, so a value is
 * passed by name (`env_vars`, `bearer_token_env_var`) or not at all: anything
 * else would put a secret on disk. (dBrain's translation.)
 */
export const mcpToCodexToml = (servers: Record<string, unknown>) => {
  const warnings: string[] = [];
  const tables: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!Predicate.isObject(server)) continue;
    const lines = [`[mcp_servers.${tomlKey(name)}]`];
    const record = server as Record<string, unknown>;
    if (typeof record.url === "string") {
      lines.push(`url = ${tomlString(record.url)}`);
      const headers = Predicate.isObject(record.headers)
        ? (record.headers as Record<string, unknown>)
        : {};
      for (const [header, value] of Object.entries(headers)) {
        if (typeof value !== "string") continue;
        const bearer = header.toLowerCase() === "authorization" ? BEARER.exec(value) : null;
        if (bearer) lines.push(`bearer_token_env_var = ${tomlString(bearer[1]!)}`);
        else if (value.includes("${"))
          warnings.push(`${name}: header ${header} can't pass to Codex by name; skipped.`);
        else lines.push(`http_headers.${tomlKey(header)} = ${tomlString(value)}`);
      }
    } else if (typeof record.command === "string") {
      lines.push(`command = ${tomlString(record.command)}`);
      const args = Array.isArray(record.args) ? record.args.filter(Predicate.isString) : [];
      if (args.length > 0) lines.push(`args = [${args.map(tomlString).join(", ")}]`);
      const env = Predicate.isObject(record.env) ? (record.env as Record<string, unknown>) : {};
      const byName: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue;
        const match = VAR.exec(value);
        if (match && match[1] === key) byName.push(key);
        else if (value.includes("${"))
          warnings.push(`${name}: env ${key} must be exactly \${${key}} for Codex; skipped.`);
        else lines.push(`env.${tomlKey(key)} = ${tomlString(value)}`);
      }
      if (byName.length > 0) lines.push(`env_vars = [${byName.map(tomlString).join(", ")}]`);
    } else {
      warnings.push(`${name}: needs a command or a url; skipped.`);
      continue;
    }
    tables.push(lines.join("\n"));
  }
  return { toml: tables.join("\n\n"), warnings };
};

const BLOCK_START = "# --- magnesium: managed by profile sync; edits here are replaced ---";
const BLOCK_END = "# --- end magnesium ---";

/** Replace our block in Codex's config.toml and keep what Codex wrote around it (trusted projects). */
export const withManagedBlock = (existing: string, block: string) => {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  const rest =
    start >= 0 && end > start
      ? `${existing.slice(0, start)}${existing.slice(end + BLOCK_END.length)}`.trim()
      : existing.trim();
  const managed = block.trim() ? `${BLOCK_START}\n${block.trim()}\n${BLOCK_END}` : "";
  return `${[managed, rest].filter(Boolean).join("\n\n")}\n`;
};

const writeIfChanged = Effect.fn("profiles.writeIfChanged")(function* (
  file: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* readOptional(file);
  if (current === content) return false;
  yield* fs.writeFileString(file, content, { mode: 0o600 });
  return true;
});

/** Point `link` at `target`, replacing whatever is there. Never reads the target. */
const ensureLink = Effect.fn("profiles.ensureLink")(function* (target: string, link: string) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* fs.readLink(link).pipe(Effect.orElseSucceed(() => undefined));
  if (current === target) return;
  yield* fs.remove(link, { recursive: true, force: true });
  yield* fs.symlink(target, link);
});

/** Each skill folder linked into the home, and links to removed skills dropped. */
const linkSkills = Effect.fn("profiles.linkSkills")(function* (
  profile: ResolvedProfile,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(profile.dir, FILES.skills);
  const target = path.join(home, FILES.skills);
  yield* fs.makeDirectory(target, { recursive: true });
  const wanted = yield* fs.readDirectory(source).pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const skill of wanted) yield* ensureLink(path.join(source, skill), path.join(target, skill));
  for (const entry of yield* fs.readDirectory(target)) {
    if (wanted.includes(entry)) continue;
    const link = yield* fs.readLink(path.join(target, entry)).pipe(Effect.orElseSucceed(() => ""));
    if (link.startsWith(source)) yield* fs.remove(path.join(target, entry), { force: true });
  }
});

/**
 * Write the profile's homes and launch settings. Idempotent; leaves what the
 * harnesses wrote. Each home links to the machine's own login (D41): the link is
 * made, the login is never read or copied.
 */
export const writeHomes = Effect.fn("profiles.writeHomes")(function* (
  profile: ResolvedProfile,
  setup: MachineSetup,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = stateDirOf(path, profile);
  const instructions = yield* renderInstructions(profile);
  const mcpText = yield* readOptional(path.join(profile.dir, FILES.mcp));
  const servers =
    mcpText === undefined
      ? {}
      : yield* decodeMcpFile(mcpText).pipe(
          Effect.map((decoded) => decoded.mcpServers),
          Effect.orElseSucceed(() => ({})),
        );
  const warnings: string[] = [];
  for (const dir of ["claude", "codex", "home"]) {
    yield* fs.makeDirectory(path.join(state, dir), { recursive: true, mode: 0o700 });
  }
  yield* writeIfChanged(path.join(state, "launch.env"), renderLaunchEnv(path, profile, setup));

  if (profile.harnesses.includes("claude")) {
    const home = path.join(state, "claude");
    yield* writeIfChanged(path.join(home, "CLAUDE.md"), instructions);
    yield* writeIfChanged(
      path.join(home, "settings.json"),
      prettyJson(yield* claudeSettings(profile)),
    );
    const mcpFile = path.join(state, "mcp.json");
    if (Object.keys(servers).length > 0) {
      yield* writeIfChanged(mcpFile, prettyJson({ mcpServers: servers }));
    } else {
      yield* fs.remove(mcpFile, { force: true });
    }
    yield* linkSkills(profile, home);
    yield* ensureLink(
      path.join(setup.userHome, ".claude", ".credentials.json"),
      path.join(home, ".credentials.json"),
    );
  }

  if (profile.harnesses.includes("codex")) {
    const home = path.join(state, "codex");
    yield* writeIfChanged(path.join(home, "AGENTS.md"), instructions);
    const { toml, warnings: mcpWarnings } = mcpToCodexToml(servers);
    warnings.push(...mcpWarnings);
    const configFile = path.join(home, "config.toml");
    yield* writeIfChanged(
      configFile,
      withManagedBlock((yield* readOptional(configFile)) ?? "", toml),
    );
    const hooks = yield* readOptional(path.join(profile.dir, FILES.hooks));
    if (hooks === undefined) yield* fs.remove(path.join(home, FILES.hooks), { force: true });
    else yield* writeIfChanged(path.join(home, FILES.hooks), hooks);
    yield* linkSkills(profile, home);
    yield* ensureLink(
      path.join(setup.userHome, ".codex", "auth.json"),
      path.join(home, "auth.json"),
    );
  }
  return warnings;
});
