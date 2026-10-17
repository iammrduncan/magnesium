// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixtures write profile folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { nativeTwinInstanceId, type ProfileBundle, profileInstanceId } from "@magnesium/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  checkProfiles,
  InstanceSource,
  listProfiles,
  listSandboxes,
  ProfilesConfig,
} from "./catalog.ts";
import { planProfile, writeHomes } from "./homes.ts";
import {
  joinLaunchArgs,
  launchArgList,
  loadProfile,
  refusedLaunchArgs,
  resolveProfile,
} from "./profileFolder.ts";
import { showList } from "../agents/cli.ts";
import { receivePush } from "./receive.ts";
import type { DetectedSetup } from "./setup.ts";
import { desiredInstances } from "./stock.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-profiles-")),
  );
  roots.push(root);
  return root;
};

const SCRATCH_A = {
  "profile.yaml": "name: scratch-a\ndescription: A scratch profile.\nmachines: [cpu-host-1]\n",
  "AGENTS.md": "You help with scratch work.\n",
  "CLAUDE.md": "End every reply with the word `ok-a`.\n",
};

const writeProfile = (folder: string, name: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    const target = NodePath.join(folder, name, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, content);
  }
};

const setupFor = (root: string, overrides: Partial<DetectedSetup> = {}): DetectedSetup => ({
  folder: NodePath.join(root, "state", "profiles"),
  machine: "cpu-host-1",
  isHub: false,
  ...overrides,
  setup: {
    stateHome: NodePath.join(root, "state"),
    wrapperDir: "/opt/magnesium/bin",
    binaries: {
      claude: "/usr/local/bin/claude",
      codex: "/usr/local/bin/codex",
      opencode: undefined,
    },
    userHome: NodePath.join(root, "home"),
    fence: { mechanism: "bwrap" },
    container: { unavailable: "Podman is not installed." },
    protect: ["/opt/magnesium"],
    ...overrides.setup,
  },
});

const provide = (config: DetectedSetup, instances: ServerSettings["providerInstances"] = {}) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ProfilesConfig, ProfilesConfig.of(config)),
    Layer.succeed(InstanceSource, InstanceSource.of({ instances: Effect.succeed(instances) })),
  );

describe("the profile check", () => {
  it.each([
    ["--dangerously-skip-permissions"],
    ["--permission-mode bypassPermissions"],
    ["--permission-mode=plan"],
    ["--allow-dangerously-skip-permissions"],
    ["--dangerously-bypass-approvals-and-sandbox"],
    ["-c approval_policy=never"],
    ["--config sandbox_mode=danger-full-access"],
    ["--settings /tmp/s.json"],
  ])("refuses %s in launch args", (args) => {
    expect(refusedLaunchArgs(args)[0]).toContain("is refused");
  });

  it("lets other launch args through", () => {
    expect(refusedLaunchArgs('--add-dir /data -c model_reasoning_effort="high"')).toEqual([]);
  });

  it.each([
    [["--dangerously-skip-permissions"]],
    [["--permission-mode", "bypassPermissions"]],
    [["--permission-mode bypassPermissions"]],
    [["-c", "approval_policy=never"]],
  ])("refuses %j in launch args written as a list", (args) => {
    expect(refusedLaunchArgs(args)[0]).toContain("is refused");
  });

  it("reads launch args as a string or a list, and hands T3 the same arguments", () => {
    const list = ["--add-dir", "/data/my files", "-c", 'model_reasoning_effort="high"'];
    expect(launchArgList('--add-dir "/data/my files" -c model_reasoning_effort=high')).toEqual([
      "--add-dir",
      "/data/my files",
      "-c",
      "model_reasoning_effort=high",
    ]);
    expect(launchArgList(list)).toEqual(list);
    expect(tokenizeCliArgs(joinLaunchArgs(list))).toEqual(list);
    expect(refusedLaunchArgs(list)).toEqual([]);
  });

  it.effect("refuses a permission flag in a launch_args list, not as a parse error", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      writeProfile(config.folder, "scratch-b", {
        ...SCRATCH_A,
        "profile.yaml": 'name: scratch-b\nlaunch_args: ["--dangerously-skip-permissions"]\n',
      });
      writeProfile(config.folder, "scratch-c", {
        ...SCRATCH_A,
        "profile.yaml": "name: scratch-c\nlaunch_args:\n  - --add-dir\n  - /data\n",
      });
      const result = yield* checkProfiles().pipe(Effect.provide(provide(config)));
      const byName = Object.fromEntries(result.profiles.map((p) => [p.name, p.issues]));
      expect(byName["scratch-b"]?.map((issue) => issue.message)).toEqual([
        "launch_args: --dangerously-skip-permissions is refused: full access is a per-thread choice, never a profile setting.",
      ]);
      expect(byName["scratch-c"]?.filter((issue) => issue.level === "error")).toEqual([]);
    }),
  );

  it.effect("refuses a profile with a permission flag and passes the others", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      writeProfile(config.folder, "scratch-a", SCRATCH_A);
      writeProfile(config.folder, "scratch-b", {
        ...SCRATCH_A,
        "profile.yaml": "name: scratch-b\nlaunch_args: --dangerously-skip-permissions\n",
      });
      const result = yield* checkProfiles().pipe(Effect.provide(provide(config)));
      expect(result.ok).toBe(false);
      const byName = Object.fromEntries(result.profiles.map((p) => [p.name, p.issues]));
      expect(byName["scratch-a"]?.filter((issue) => issue.level === "error")).toEqual([]);
      expect(byName["scratch-b"]?.map((issue) => issue.message).join(" ")).toContain(
        "--dangerously-skip-permissions is refused: full access is a per-thread choice",
      );
    }),
  );

  it.effect("refuses native as a default, secrets in files, and a missing AGENTS.md", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      writeProfile(config.folder, "nat", {
        ...SCRATCH_A,
        "profile.yaml": "sandbox:\n  level: native\n",
      });
      writeProfile(config.folder, "leaky", {
        ...SCRATCH_A,
        "profile.yaml": "name: leaky\n",
        "mcp.json":
          '{"mcpServers":{"kb":{"type":"http","url":"https://kb","headers":{"Authorization":"Bearer sk-abcdefghijklmnop"}}}}',
      });
      writeProfile(config.folder, "bare", { "profile.yaml": "name: bare\n" });
      const result = yield* checkProfiles().pipe(Effect.provide(provide(config)));
      const messages = Object.fromEntries(
        result.profiles.map((p) => [p.name, p.issues.map((issue) => issue.message).join(" ")]),
      );
      expect(messages.nat).toContain("never as a default");
      expect(messages.leaky).toContain("holds a secret");
      expect(messages.bare).toContain("Missing; it holds the agent's role");
    }),
  );
});

describe("profile instances", () => {
  it.effect("run fenced by default, with native and, where Podman is ready, container", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      writeProfile(config.folder, "scratch-a", SCRATCH_A);
      const path = yield* Path.Path;
      const profile = resolveProfile(yield* loadProfile(config.folder, "scratch-a"));
      const plan = planProfile(path, profile, config.setup);
      expect(plan.instances.map((instance) => instance.instanceId)).toEqual([
        profileInstanceId("claude", "fenced", "scratch-a"),
        profileInstanceId("claude", "native", "scratch-a"),
      ]);
      const [fenced] = plan.instances;
      expect(fenced?.config.config).toMatchObject({
        binaryPath: "/opt/magnesium/bin/magnesium-claude",
        homePath: NodePath.join(config.folder, "scratch-a", ".magnesium", "claude"),
      });
      // Names only: a secret never reaches an instance's environment.
      expect(fenced?.config.environment?.map((entry) => entry.name)).toEqual([
        "MAGNESIUM_PROFILE",
        "MAGNESIUM_SANDBOX",
      ]);
      const withPodman = planProfile(path, profile, {
        ...config.setup,
        container: { image: "docker.io/library/node@sha256:abc" },
      });
      expect(withPodman.instances.map((instance) => instance.sandbox)).toEqual([
        "fenced",
        "native",
        "container",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("write a home that obeys the profile's CLAUDE.md and links the machine's login", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      writeProfile(config.folder, "scratch-a", {
        ...SCRATCH_A,
        "profile.yaml": "name: scratch-a\nharnesses: [claude, codex]\n",
        "mcp.json":
          '{"mcpServers":{"gbrain":{"type":"http","url":"https://kb.example/mcp","headers":{"Authorization":"Bearer ${GBRAIN_TOKEN}"}}}}',
      });
      const profile = resolveProfile(yield* loadProfile(config.folder, "scratch-a"));
      yield* writeHomes(profile, config.setup);
      const state = NodePath.join(config.folder, "scratch-a", ".magnesium");
      expect(NodeFS.readFileSync(NodePath.join(state, "claude", "CLAUDE.md"), "utf8")).toContain(
        "End every reply with the word `ok-a`.",
      );
      // The login is linked, never read or copied: the target does not even exist here.
      expect(NodeFS.readlinkSync(NodePath.join(state, "claude", ".credentials.json"))).toBe(
        NodePath.join(root, "home", ".claude", ".credentials.json"),
      );
      expect(NodeFS.readlinkSync(NodePath.join(state, "codex", "auth.json"))).toBe(
        NodePath.join(root, "home", ".codex", "auth.json"),
      );
      const toml = NodeFS.readFileSync(NodePath.join(state, "codex", "config.toml"), "utf8");
      expect(toml).toContain('bearer_token_env_var = "GBRAIN_TOKEN"');
      // Codex's own additions survive the next sync.
      NodeFS.appendFileSync(
        NodePath.join(state, "codex", "config.toml"),
        '\n[projects."/work"]\ntrust_level = "trusted"\n',
      );
      yield* writeHomes(profile, config.setup);
      expect(NodeFS.readFileSync(NodePath.join(state, "codex", "config.toml"), "utf8")).toContain(
        'trust_level = "trusted"',
      );
      const launch = NodeFS.readFileSync(NodePath.join(state, "launch.env"), "utf8");
      expect(launch).toContain(`MG_STATE_HOME='${NodePath.join(root, "state")}'`);
      expect(launch).toContain("MG_FENCE='bwrap'");
      expect(launch).not.toContain("GBRAIN_TOKEN=");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("stock instances", () => {
  const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...overrides,
  });
  const run = (
    root: string,
    current: ServerSettings,
    installed: (binary: string) => boolean = () => true,
  ) =>
    Effect.map(Path.Path, (path) =>
      desiredInstances({
        path,
        settings: current,
        setup: setupFor(root).setup,
        profiles: [],
        installed,
      }),
    );

  it.effect("are all off on a gateway, which holds its namespace's deploy identity", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const path = yield* Path.Path;
      const current = settings({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex") },
        },
      });
      const base = setupFor(root);
      const next = desiredInstances({
        path,
        settings: current,
        setup: { ...base.setup, runsAgents: false },
        profiles: [],
        installed: () => true,
      });
      // Every instance there, and each default that runs unconfigured, is off; no twin, no profile.
      expect(Object.values(next).every((instance) => instance.enabled === false)).toBe(true);
      expect(Object.keys(next).toSorted()).toEqual(["claudeAgent", "codex"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("are fenced under their own ids, each with a native twin", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const next = yield* run(root, settings(), (binary) => binary === "codex");
      const codex = next[ProviderInstanceId.make("codex")];
      expect(codex?.config).toMatchObject({ binaryPath: "/opt/magnesium/bin/magnesium-fenced" });
      expect(
        Object.fromEntries((codex?.environment ?? []).map((e) => [e.name, e.value])),
      ).toMatchObject({
        MAGNESIUM_SANDBOX: "fenced",
        MAGNESIUM_REAL_BIN: "codex",
        MAGNESIUM_STATE_HOME: NodePath.join(root, "state"),
        MAGNESIUM_FENCE_PROTECT: "/opt/magnesium",
      });
      const twin = next[ProviderInstanceId.make(nativeTwinInstanceId("codex"))];
      expect(twin?.displayName).toBe("Codex · native");
      expect(twin?.config).toMatchObject({ binaryPath: "codex" });
      // Claude is not installed here: its stock default is left as it is.
      expect(next[ProviderInstanceId.make("claudeAgent")]).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follow a machine into a pod: another install's wrapper becomes this one's", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      // As settings.json came over from the machine's bare-metal home.
      const moved = settings({
        providerInstances: {
          [ProviderInstanceId.make("opencode")]: {
            driver: ProviderDriverKind.make("opencode"),
            environment: [
              { name: "MAGNESIUM_SANDBOX", value: "fenced", sensitive: false },
              {
                name: "MAGNESIUM_REAL_BIN",
                value: "/home/agent/.local/bin/opencode",
                sensitive: false,
              },
            ],
            config: {
              binaryPath:
                "/home/agent/.local/share/magnesium/current/magnesium/deploy/bin/magnesium-fenced",
            },
          },
        },
      });
      // Only the image's OpenCode, found on the PATH, is here.
      const next = yield* run(root, moved, (binary) => binary === "opencode");
      const opencode = next[ProviderInstanceId.make("opencode")];
      expect(opencode?.config).toMatchObject({ binaryPath: "/opt/magnesium/bin/magnesium-fenced" });
      expect(
        Object.fromEntries((opencode?.environment ?? []).map((e) => [e.name, e.value])),
      ).toMatchObject({ MAGNESIUM_SANDBOX: "fenced", MAGNESIUM_REAL_BIN: "opencode" });
      expect(next[ProviderInstanceId.make(nativeTwinInstanceId("opencode"))]?.config).toMatchObject(
        {
          binaryPath: "opencode",
        },
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("settle: a second sync over its own output changes nothing", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const once = yield* run(root, settings());
      const twice = yield* run(
        root,
        settings({ providerInstances: once as ServerSettings["providerInstances"] }),
      );
      expect(twice).toEqual(once);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stay native when set so by hand, and lose instances of profiles that went", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const gone = ProviderInstanceId.make(profileInstanceId("claude", "fenced", "old"));
      const next = yield* run(
        root,
        settings({
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex" as never,
              environment: [{ name: "MAGNESIUM_SANDBOX", value: "native", sensitive: false }],
              config: { binaryPath: "/usr/bin/codex" },
            },
            [gone]: { driver: "claudeAgent" as never, config: {} },
          } as ServerSettings["providerInstances"],
        }),
      );
      expect(next[ProviderInstanceId.make("codex")]?.config).toMatchObject({
        binaryPath: "/usr/bin/codex",
      });
      expect(next[gone]).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("taking a push from the hub", () => {
  const bundle = (name: string, files: Record<string, string>): ProfileBundle => ({
    name,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      contentBase64: Buffer.from(content).toString("base64"),
    })),
  });

  it.effect("writes good profiles, refuses bad ones, and keeps every home", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root);
      const layer = provide(config);
      const first = yield* receivePush({
        revision: "r1",
        profiles: [
          bundle("scratch-a", SCRATCH_A),
          bundle("scratch-b", { ...SCRATCH_A, "profile.yaml": "name: scratch-b\n" }),
        ],
      }).pipe(Effect.provide(layer));
      expect(first.accepted).toEqual(["scratch-a", "scratch-b"]);
      NodeFS.mkdirSync(NodePath.join(config.folder, "scratch-b", ".magnesium", "claude"), {
        recursive: true,
      });
      NodeFS.writeFileSync(
        NodePath.join(config.folder, "scratch-b", ".magnesium", "claude", "session"),
        "kept",
      );

      const second = yield* receivePush({
        revision: "r2",
        profiles: [
          bundle("scratch-a", {
            ...SCRATCH_A,
            "profile.yaml": "name: scratch-a\nlaunch_args: --dangerously-skip-permissions\n",
          }),
          bundle("escape", { ...SCRATCH_A, "profile.yaml": "name: escape\n", "../../evil": "x" }),
        ],
      }).pipe(Effect.provide(layer));
      expect(second.refused.map((profile) => profile.name)).toEqual(["scratch-a", "escape"]);
      expect(second.removed).toEqual(["scratch-b"]);
      // The refused profile keeps its last good copy; the removed one keeps its home.
      expect(
        NodeFS.readFileSync(NodePath.join(config.folder, "scratch-a", "profile.yaml"), "utf8"),
      ).toBe(SCRATCH_A["profile.yaml"]);
      expect(NodeFS.existsSync(NodePath.join(root, "evil"))).toBe(false);
      expect(
        NodeFS.readFileSync(
          NodePath.join(config.folder, "scratch-b", ".magnesium", "claude", "session"),
          "utf8",
        ),
      ).toBe("kept");
      const list = yield* listProfiles().pipe(Effect.provide(layer));
      expect(list.profiles.map((profile) => [profile.name, profile.runsHere])).toEqual([
        ["scratch-a", true],
      ]);
    }),
  );

  it.effect("is refused by the hub, whose folder is the owner's", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const error = yield* receivePush({ revision: "r1", profiles: [] }).pipe(
        Effect.provide(provide(setupFor(root, { isHub: true }))),
        Effect.flip,
      );
      expect(error.message).toContain("This server is the hub");
    }),
  );
});

describe("magnesium-agents list", () => {
  it.effect("says what runs here, from the instances this server runs, or that it isn't here", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const config = setupFor(root, { folder: NodePath.join(root, "state", "profiles") });
      writeProfile(config.folder, "scratch-a", {
        ...SCRATCH_A,
        "profile.yaml": "name: scratch-a\nharnesses: [claude, codex]\nmachines: [cpu-host-1]\n",
      });
      writeProfile(config.folder, "elsewhere", {
        ...SCRATCH_A,
        "profile.yaml": "name: elsewhere\nmachines: [gpu-host-1]\n",
      });
      writeProfile(config.folder, "pending", {
        ...SCRATCH_A,
        "profile.yaml": "name: pending\nmachines: [cpu-host-1]\n",
      });
      const running = Object.fromEntries(
        (
          [
            ["claude", "fenced"],
            ["claude", "native"],
            ["codex", "container"],
            ["codex", "fenced"],
            ["codex", "native"],
          ] as const
        ).map(([harness, level]) => [
          ProviderInstanceId.make(profileInstanceId(harness, level, "scratch-a")),
          { driver: (harness === "claude" ? "claudeAgent" : "codex") as never },
        ]),
      ) as ServerSettings["providerInstances"];
      const list = yield* listProfiles().pipe(Effect.provide(provide(config, running)));
      const lines = showList(list).split("\n");
      expect(lines.find((line) => line.startsWith("scratch-a"))).toContain(
        "claude, codex · fenced, container, native",
      );
      expect(lines.find((line) => line.startsWith("elsewhere"))).toContain("not here");
      expect(lines.find((line) => line.startsWith("pending"))).toContain("nothing here yet");
    }),
  );
});

describe("list_sandboxes", () => {
  it.effect("says which levels run here, why not, and each instance's level", () =>
    Effect.gen(function* () {
      const root = tempRoot();
      const list = yield* listSandboxes().pipe(
        Effect.provide(
          provide(setupFor(root), {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex" as never,
              environment: [{ name: "MAGNESIUM_SANDBOX", value: "fenced", sensitive: false }],
            },
            [ProviderInstanceId.make(nativeTwinInstanceId("codex"))]: { driver: "codex" as never },
          } as ServerSettings["providerInstances"]),
        ),
      );
      expect(list.levels.map((level) => [level.level, level.available])).toEqual([
        ["fenced", true],
        ["container", false],
        ["native", true],
        ["microvm", false],
      ]);
      expect(list.levels[1]?.note).toBe("Podman is not installed.");
      expect(list.levels[1]?.enable).toContain("Install rootless Podman");
      expect(list.instances).toEqual([
        { instanceId: "codex", level: "fenced", group: "codex", profile: null },
        { instanceId: "mg_native_codex", level: "native", group: "codex", profile: null },
      ]);
    }),
  );

  it.effect("in a pod, says what works there instead of what to install (goal 25)", () =>
    Effect.gen(function* () {
      const base = setupFor(tempRoot());
      const inPod = {
        ...base,
        setup: {
          ...base.setup,
          deployment: "pod" as const,
          fence: { mechanism: "landlock" },
          container: { unavailable: "Agents can't start containers inside a pod." },
        },
      };
      const list = yield* listSandboxes().pipe(
        Effect.provide(provide(inPod, {} as ServerSettings["providerInstances"])),
      );
      expect(list.levels[0]?.note).toContain("the strongest fence a pod allows");
      expect(list.levels[1]?.note).toBe("Agents can't start containers inside a pod.");
      expect(list.levels[1]?.enable).toContain("on bare metal or in a VM");
    }),
  );
});
