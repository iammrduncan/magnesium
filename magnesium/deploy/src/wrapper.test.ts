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

/** Whether this machine can fence (bubblewrap, Landlock or Seatbelt); fence tests need one. */
const fence = NodeChildProcess.spawnSync(NodePath.join(bin, "magnesium-fence"), ["--probe"], {
  encoding: "utf8",
});
const canFence = fence.status === 0;

interface Call {
  readonly name: string;
  readonly args: Array<string>;
  readonly secret: string | null;
  /** What happened when it tried to read the state home's canary. */
  readonly canary: "read" | "denied";
  readonly homeWritable: boolean;
}

/**
 * A server's state home with a canary in its secrets, a profile in it as sync
 * writes it, and fake `claude`, `codex` and `podman` that record their argv, a
 * secret they inherit, and whether they can read the canary.
 */
function makeProfile(options: { readonly image?: string; readonly mcp?: boolean } = {}) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-wrap-")));
  roots.push(root);
  const stateHome = NodePath.join(root, "state");
  const canary = NodePath.join(stateHome, "userdata", "secrets", "canary");
  const profileDir = NodePath.join(stateHome, "profiles", "scratch-a");
  const state = NodePath.join(profileDir, ".magnesium");
  const fakes = NodePath.join(root, "fakes");
  const project = NodePath.join(root, "project");
  const record = NodePath.join(root, "calls.jsonl");
  for (const dir of [
    NodePath.dirname(canary),
    NodePath.join(state, "claude"),
    NodePath.join(state, "codex"),
    NodePath.join(state, "home"),
    NodePath.join(fakes, "bin"),
    project,
  ]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(canary, "canary-token");
  NodeFS.writeFileSync(
    NodePath.join(fakes, "fake.cjs"),
    `const fs = require("node:fs");
const [name, ...args] = process.argv.slice(2);
let canary = "denied";
try { fs.readFileSync(${JSON.stringify(canary)}); canary = "read"; } catch {}
let homeWritable = false;
const home = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME;
try { if (home) { fs.writeFileSync(home + "/probe", "x"); homeWritable = true; } } catch {}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ name, args, secret: process.env.GBRAIN_TOKEN ?? null, canary, homeWritable }) + "\\n");
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
      `MG_FENCE=''`,
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
  return { root, stateHome, profileDir, state, project, claude, run, harness, log };
}

const SESSION = ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
const PROBE = [...SESSION, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

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

  it.skipIf(!canFence)(
    "fence by default: the state home is unreadable, the profile's home is not",
    () => {
      const profile = makeProfile();
      const result = profile.harness("claude", "fenced", SESSION);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toMatchObject([
        {
          name: "claude",
          args: SESSION,
          secret: "secret-value",
          canary: "denied",
          homeWritable: true,
        },
      ]);
    },
  );

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

  it.skipIf(!canFence)(
    "run probes fenced at any level, so a provider refresh starts no container",
    () => {
      const profile = makeProfile();
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

  it("treat every codex app-server as a session", () => {
    const profile = makeProfile();
    const result = profile.harness("codex", "container", ["app-server"]);
    expect(result.calls[0]?.name).toBe("podman");
    expect(result.calls[0]?.args.slice(-1)).toEqual(["app-server"]);
  });

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

describe("magnesium-fenced and magnesium-fence", () => {
  it.skipIf(!canFence)("fence a stock instance's CLI from the state home", () => {
    const profile = makeProfile();
    const result = profile.run("magnesium-fenced", ["app-server"], {
      MAGNESIUM_REAL_BIN: profile.claude,
      MAGNESIUM_STATE_HOME: profile.stateHome,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toMatchObject([
      { name: "claude", args: ["app-server"], canary: "denied" },
    ]);
  });

  it.skipIf(!canFence)("let a protected path be read but never changed", () => {
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
      },
    );
    expect(result.stdout).toContain("code");
    expect(result.stdout).toContain("protected");
    expect(NodeFS.readFileSync(installed, "utf8")).toBe("code");
  });

  it("say which fence this machine has", () => {
    expect(fence.stdout.trim()).toMatch(/^(bwrap|landlock|seatbelt|none: .+)$/);
  });
});
