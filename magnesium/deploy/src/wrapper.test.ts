// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const bin = NodePath.resolve(import.meta.dirname, "../bin");
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const probe = (...args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync(
    NodePath.join(bin, "magnesium-fence"),
    ["--probe", ...args],
    { encoding: "utf8" },
  );
  return { ok: result.status === 0, said: result.stdout.trim() };
};

/** Each fence this machine can run; every test of one runs it on purpose, through MAGNESIUM_FENCE. */
const MECHANISMS = ["bwrap", "userns", "landlock", "seatbelt"] as const;
type Mechanism = (typeof MECHANISMS)[number];
const available = Object.fromEntries(
  MECHANISMS.map((mechanism) => [mechanism, probe(mechanism)]),
) as Record<Mechanism, { ok: boolean; said: string }>;
/** The test's name, with why it is skipped on this machine. */
const named = (mechanism: Mechanism, name: string) =>
  available[mechanism].ok ? name : `${name} (skipped: ${available[mechanism].said})`;
const anyFence = MECHANISMS.find((mechanism) => available[mechanism].ok);

interface Call {
  readonly name: string;
  readonly args: Array<string>;
  readonly secret: string | null;
  /** What happened when it tried to read the state home's canary. */
  readonly canary: "read" | "denied";
  readonly homeWritable: boolean;
  readonly workspaceWritable: boolean;
  /** A new file in a folder beside the state home, under the same parent. */
  readonly besideWritable: boolean;
  readonly tmpWritable: boolean;
}

/**
 * A server's state home with a canary in its secrets, a profile in it as sync
 * writes it, and fake `claude`, `codex` and `podman` that record their argv, a
 * secret they inherit, and what they could read and write. The record goes to a
 * folder beside the state home, as a project or cache would be.
 */
function makeProfile(
  options: {
    readonly image?: string;
    readonly mcp?: boolean;
    readonly fence?: Mechanism | undefined;
  } = {},
) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-wrap-")));
  roots.push(root);
  const stateHome = NodePath.join(root, "state");
  const canary = NodePath.join(stateHome, "userdata", "secrets", "canary");
  const profileDir = NodePath.join(stateHome, "profiles", "scratch-a");
  const state = NodePath.join(profileDir, ".magnesium");
  const fakes = NodePath.join(root, "fakes");
  const project = NodePath.join(root, "project");
  const out = NodePath.join(root, "out");
  // The machine's tmp is not beside the state home in a real install (~/.magnesium).
  const tmp = NodePath.join(root, "tmp");
  const record = NodePath.join(out, "calls.jsonl");
  for (const dir of [
    NodePath.dirname(canary),
    NodePath.join(state, "claude"),
    NodePath.join(state, "codex"),
    NodePath.join(state, "home"),
    NodePath.join(fakes, "bin"),
    project,
    out,
    tmp,
  ]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(canary, "canary-token");
  NodeFS.writeFileSync(
    NodePath.join(fakes, "fake.cjs"),
    `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const [name, ...args] = process.argv.slice(2);
const tries = (fn) => { try { fn(); return true; } catch { return false; } };
const home = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  name,
  args,
  secret: process.env.GBRAIN_TOKEN ?? null,
  canary: tries(() => fs.readFileSync(${JSON.stringify(canary)})) ? "read" : "denied",
  homeWritable: Boolean(home) && tries(() => fs.writeFileSync(home + "/probe", "x")),
  workspaceWritable: tries(() => fs.writeFileSync("written-here", "x")),
  besideWritable: tries(() => fs.writeFileSync(path.join(${JSON.stringify(out)}, "new-" + process.pid), "x")),
  tmpWritable: tries(() => fs.rmSync(fs.mkdtempSync(path.join(os.tmpdir(), "t-")), { recursive: true })),
}) + "\\n");
`,
  );
  const fake = (name: string) => {
    const file = NodePath.join(fakes, "bin", name);
    NodeFS.writeFileSync(
      file,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(NodePath.join(fakes, "fake.cjs"))} ${name} "$@"\n`,
      { mode: 0o755 },
    );
    return file;
  };
  const claude = fake("claude");
  const codex = fake("codex");
  fake("podman");
  NodeFS.writeFileSync(
    NodePath.join(state, "launch.env"),
    [
      `MG_PROFILE='scratch-a'`,
      `MG_PROFILE_DIR=${quote(profileDir)}`,
      `MG_STATE_DIR=${quote(state)}`,
      `MG_STATE_HOME=${quote(stateHome)}`,
      `MG_FENCE=${quote(options.fence ?? "")}`,
      `MG_PROTECT=''`,
      `MG_CONTAINER_HOME=${quote(NodePath.join(state, "home"))}`,
      `MG_IMAGE=${quote(options.image ?? "docker.io/library/node@sha256:abc")}`,
      `MG_NETWORK='internet'`,
      `MG_SERVER_PORT='3773'`,
      `MG_PASS_ENV='GBRAIN_TOKEN'`,
      `MG_MOUNTS=''`,
      `MG_CLAUDE_BIN=${quote(claude)}`,
      `MG_CODEX_BIN=${quote(codex)}`,
      "",
    ].join("\n"),
  );
  if (options.mcp) NodeFS.writeFileSync(NodePath.join(state, "mcp.json"), '{"mcpServers":{}}');

  const readCalls = (): Array<Call> => {
    const calls = NodeFS.existsSync(record)
      ? NodeFS.readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Call)
      : [];
    NodeFS.rmSync(record, { force: true });
    return calls;
  };
  const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
    const result = NodeChildProcess.spawnSync(NodePath.join(bin, command), args, {
      cwd: project,
      encoding: "utf8",
      env: {
        PATH: `${NodePath.join(fakes, "bin")}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? root,
        TMPDIR: tmp,
        GBRAIN_TOKEN: "secret-value",
        ...env,
      },
    });
    return { ...result, calls: readCalls() };
  };
  const harness = (
    name: "claude" | "codex",
    level: string,
    args: ReadonlyArray<string>,
    env: Record<string, string> = {},
  ) =>
    run(`magnesium-${name}`, args, {
      [name === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: NodePath.join(state, name),
      MAGNESIUM_SANDBOX: level,
      ...env,
    });
  const log = () => NodeFS.readFileSync(NodePath.join(state, "wrapper.log"), "utf8");
  return { root, stateHome, profileDir, state, project, out, claude, run, harness, log };
}

const SESSION = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
const PROBE = [...SESSION, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

/** What every fence promises: only the state home is out of reach. */
const FENCED = {
  canary: "denied",
  homeWritable: true,
  workspaceWritable: true,
  besideWritable: true,
  tmpWritable: true,
} as const;

describe("magnesium-claude and magnesium-codex", () => {
  it("run native only when asked, with the profile's MCP servers and nothing hidden", () => {
    const profile = makeProfile({ mcp: true });
    const result = profile.harness("claude", "native", SESSION);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls).toMatchObject([
      {
        name: "claude",
        args: [...SESSION, "--mcp-config", NodePath.join(profile.state, "mcp.json")],
        secret: "secret-value",
        canary: "read",
      },
    ]);
    expect(profile.log()).toContain(`home=${NodePath.join(profile.state, "claude")}`);
    expect(profile.log()).toContain(`cwd=${profile.project}`);
    expect(profile.log()).toContain("level=native mode=session");
  });

  it("run a container session through podman, with secrets by name only", () => {
    const profile = makeProfile();
    const result = profile.harness("claude", "container", SESSION);
    expect(result.status).toBe(0);
    const [call] = result.calls;
    expect(call?.name).toBe("podman");
    const args = call?.args ?? [];
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "-i", "--init", "--name"]);
    expect(args).toContain("--userns=keep-id");
    expect(args).toContain("--cap-drop=ALL");
    // The secret's name crosses into the container; its value never reaches argv.
    expect(args).toContain("GBRAIN_TOKEN");
    expect(args.join(" ")).not.toContain("secret-value");
    expect(args).toContain(`${profile.profileDir}:${profile.profileDir}:ro`);
    const home = NodePath.join(profile.state, "claude");
    expect(args).toContain(`${home}:${home}:rw`);
    expect(args).toContain(`${profile.project}:${profile.project}:rw`);
    // Nothing else from the state home is mounted.
    expect(
      args.filter(
        (arg) => arg.startsWith(profile.stateHome) && !arg.startsWith(profile.profileDir),
      ),
    ).toEqual([]);
    expect(args).toContain(`io.magnesium.state=${profile.stateHome}`);
    // Its own address, and the server's port forwarded, so it reaches T3's MCP tools
    // whether the server listens on loopback or on the host's address.
    expect(args).toContain("--network=pasta:-a,10.255.254.2,-n,30,-g,10.255.254.1,-T,3773");
    expect(profile.log()).toContain("level=container mode=session");
  });

  it("pass Codex the arguments T3 gives it, at every level", () => {
    // Codex's own sandbox is switched off by the server under the fence or a
    // container (CodexSessionRuntime), never by a launch flag the wrapper adds.
    const profile = makeProfile({ fence: anyFence });
    expect(profile.harness("codex", "native", ["app-server"]).calls[0]?.args).toEqual([
      "app-server",
    ]);
    expect(profile.harness("codex", "container", ["app-server"]).calls[0]?.args.slice(-1)).toEqual([
      "app-server",
    ]);
    if (anyFence !== undefined) {
      expect(profile.harness("codex", "fenced", ["app-server"]).calls[0]?.args).toEqual([
        "app-server",
      ]);
    }
  });

  it.skipIf(anyFence === undefined)(
    `run probes fenced at any level, so a provider refresh starts no container${anyFence === undefined ? " (skipped: no fence here)" : ""}`,
    () => {
      const profile = makeProfile({ fence: anyFence });
      expect(profile.harness("claude", "container", ["--version"]).calls[0]).toMatchObject({
        name: "claude",
        canary: "denied",
      });
      expect(profile.harness("claude", "container", PROBE).calls[0]?.name).toBe("claude");
      expect(profile.harness("codex", "container", ["login", "status"]).calls[0]?.name).toBe(
        "codex",
      );
      expect(profile.log().match(/mode=probe/g)).toHaveLength(3);
    },
  );

  it("refuse to start without a profile home, a level it knows, or an image", () => {
    const profile = makeProfile({ image: "" });
    expect(profile.harness("claude", "container", SESSION).stderr).toContain(
      "needs an image (MAGNESIUM_SANDBOX_IMAGE)",
    );
    expect(profile.harness("claude", "microvm", SESSION).stderr).toContain(
      "the microvm sandbox is not available here",
    );
    const noHome = profile.harness("claude", "native", SESSION, { CLAUDE_CONFIG_DIR: "" });
    expect(noHome.status).toBe(78);
    expect(noHome.stderr).toContain("CLAUDE_CONFIG_DIR is not set");
  });
});

describe.each(MECHANISMS)("the %s fence", (mechanism) => {
  const skip = !available[mechanism].ok;

  it.skipIf(skip)(
    named(mechanism, "hides the state home and nothing else from a profile's agent"),
    () => {
      const profile = makeProfile({ fence: mechanism });
      const result = profile.harness("claude", "fenced", SESSION);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toMatchObject([{ name: "claude", args: SESSION, ...FENCED }]);
      expect(result.calls[0]?.secret).toBe("secret-value");
    },
  );

  it.skipIf(skip)(named(mechanism, "fences a stock instance's CLI the same way"), () => {
    const profile = makeProfile();
    const result = profile.run("magnesium-fenced", ["app-server"], {
      MAGNESIUM_REAL_BIN: profile.claude,
      MAGNESIUM_STATE_HOME: profile.stateHome,
      MAGNESIUM_FENCE: mechanism,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toMatchObject([
      {
        name: "claude",
        args: ["app-server"],
        canary: "denied",
        workspaceWritable: true,
        tmpWritable: true,
      },
    ]);
  });

  it.skipIf(skip)(named(mechanism, "lets a protected path be read but never changed"), () => {
    const profile = makeProfile();
    const installed = NodePath.join(profile.root, "install", "server.js");
    NodeFS.mkdirSync(NodePath.dirname(installed), { recursive: true });
    NodeFS.writeFileSync(installed, "code");
    const result = profile.run(
      "magnesium-fence",
      [
        "--",
        "sh",
        "-c",
        `cat ${quote(installed)}; echo evil >> ${quote(installed)} || echo protected`,
      ],
      {
        MAGNESIUM_STATE_HOME: profile.stateHome,
        MAGNESIUM_FENCE_PROTECT: NodePath.dirname(installed),
        MAGNESIUM_FENCE: mechanism,
      },
    );
    expect(result.stdout).toContain("code");
    expect(result.stdout).toContain("protected");
    expect(NodeFS.readFileSync(installed, "utf8")).toBe("code");
  });
});

describe("the landlock fence's limit", () => {
  // Landlock can only grant: "everything but the state home" is every sibling on
  // the way down to it, so its parent folders themselves get nothing. Files and
  // folders already beside it work; nothing new can be made directly in them.
  it.skipIf(!available.landlock.ok)(
    named("landlock", "keeps what is beside the state home, but nothing new appears there"),
    () => {
      const profile = makeProfile();
      const existing = NodePath.join(profile.root, "existing.log");
      NodeFS.writeFileSync(existing, "");
      const result = profile.run(
        "magnesium-fence",
        [
          "--",
          "sh",
          "-c",
          `echo x >> ${quote(existing)} && echo existing-ok; (echo x > ${quote(NodePath.join(profile.root, "new.log"))}) 2>/dev/null || echo new-refused`,
        ],
        { MAGNESIUM_STATE_HOME: profile.stateHome, MAGNESIUM_FENCE: "landlock" },
      );
      expect(result.stdout).toContain("existing-ok");
      expect(result.stdout).toContain("new-refused");
    },
  );
});

describe("magnesium-fence --probe", () => {
  it("says which fence this machine uses, and why a missing one is missing", () => {
    expect(probe().said).toMatch(/^(bwrap|userns|landlock|seatbelt|none: .+)$/);
    for (const mechanism of MECHANISMS) {
      expect(available[mechanism].said.length).toBeGreaterThan(0);
      if (available[mechanism].ok) expect(available[mechanism].said).toBe("ok");
    }
    expect(probe("nothing").said).toBe("no fence called nothing");
  });
});
