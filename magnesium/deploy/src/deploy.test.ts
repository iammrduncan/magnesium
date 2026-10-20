// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const deployRoot = NodePath.resolve(import.meta.dirname, "..");

const onPath = (command: string) =>
  NodeChildProcess.spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;

/** How to run Ansible here: installed, through uvx, or not at all. */
const ansiblePlaybook: ReadonlyArray<string> | null = onPath("ansible-playbook")
  ? ["ansible-playbook"]
  : onPath("uvx")
    ? ["uvx", "--from", "ansible-core", "ansible-playbook"]
    : null;

/** The units that run a server, not helpers such as the backup. */
const unitFiles = (): Array<string> =>
  NodeFS.readdirSync(NodePath.join(deployRoot, "systemd"))
    .filter((name) => name.endsWith(".service"))
    .map((name) => NodePath.join(deployRoot, "systemd", name))
    .filter((unit) => /^ExecStart=.*\/bin\.mjs /m.test(NodeFS.readFileSync(unit, "utf8")));

const environmentOf = (unit: string): Map<string, string> =>
  new Map(
    NodeFS.readFileSync(unit, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("Environment="))
      .map((line) => {
        const [name = "", ...value] = line.slice("Environment=".length).split("=");
        return [name, value.join("=")] as const;
      }),
  );

describe("deploy assets", () => {
  it("turns telemetry off in every service unit", () => {
    const units = unitFiles();
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(environmentOf(unit).get("T3CODE_TELEMETRY_ENABLED"), unit).toBe("false");
    }
  });

  it("keeps every unit's state out of a T3 Code home", () => {
    for (const unit of unitFiles()) {
      const home = environmentOf(unit).get("T3CODE_HOME");
      expect(home, unit).toBeDefined();
      expect(home, unit).not.toMatch(/\/\.t3\/?$/);
      expect(NodeFS.readFileSync(unit, "utf8"), unit).not.toMatch(/^ExecStart=.*service install/m);
    }
  });

  it("keeps the startup pairing token out of the journal", () => {
    for (const unit of unitFiles()) {
      const text = NodeFS.readFileSync(unit, "utf8");
      expect(text, unit).toMatch(/^ExecStart=.* serve$/m);
      expect(text, unit).toMatch(/^StandardOutput=null$/m);
    }
  });

  it("binds an address the hub reaches, whatever the network", () => {
    const text = NodeFS.readFileSync(
      NodePath.join(deployRoot, "ansible/roles/magnesium_server/templates/magnesium.env.j2"),
      "utf8",
    );
    // The role chooses the address (tasks/host.yml); the template never asks Tailscale itself.
    expect(text).toMatch(/^T3CODE_HOST=\{\{ magnesium_bind_host \}\}$/m);
    expect(text).not.toMatch(/tailnet|tailscale/i);
  });

  it.skipIf(ansiblePlaybook === null)(
    "chooses hosts and writes the hub's machines on a LAN, a tailnet and a single box",
    () => {
      const [command, ...prefix] = ansiblePlaybook!;
      // Throws, with Ansible's output, when any check in the playbook fails.
      NodeChildProcess.execFileSync(
        command!,
        [...prefix, "-i", "localhost,", "-c", "local", "tests/network.yml"],
        { cwd: NodePath.join(deployRoot, "ansible"), stdio: "pipe", timeout: 180_000 },
      );
    },
    200_000,
  );

  describe("a pod's first start with OpenCode configured", () => {
    /** Runs the pod's entrypoint against a stand-in release whose server exits at once. */
    const start = (settings?: unknown): unknown => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-entrypoint-"));
      try {
        const release = NodePath.join(root, "portable", "current");
        NodeFS.mkdirSync(NodePath.join(release, "magnesium/deploy/seed"), { recursive: true });
        NodeFS.copyFileSync(
          NodePath.join(deployRoot, "seed/settings.json"),
          NodePath.join(release, "magnesium/deploy/seed/settings.json"),
        );
        NodeFS.mkdirSync(NodePath.join(release, "apps/server/dist"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(release, "apps/server/dist/bin.mjs"), "");
        const home = NodePath.join(root, "home");
        const file = NodePath.join(home, ".magnesium/userdata/settings.json");
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        if (settings !== undefined) NodeFS.writeFileSync(file, JSON.stringify(settings));
        NodeChildProcess.execFileSync("bash", [NodePath.join(deployRoot, "container/entrypoint")], {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            MAGNESIUM_ROOT: NodePath.join(root, "portable"),
            MAGNESIUM_NODE_BIN: process.execPath,
            MAGNESIUM_OPENCODE_BASE_URL: "https://llm-gateway.example.com/v1",
            MAGNESIUM_OPENCODE_MODELS: " model-a, model-b",
          },
          stdio: "pipe",
        });
        return JSON.parse(NodeFS.readFileSync(file, "utf8"));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    };

    it("turns OpenCode on, with its first model as the default", () => {
      const selection = { instanceId: "opencode", model: "litellm/model-a" };
      expect(start()).toEqual({
        defaultRuntimeMode: "approval-required",
        enableProviderUpdateChecks: false,
        providerInstances: { opencode: { driver: "opencode", enabled: true } },
        defaultModelSelection: selection,
        textGenerationModelSelection: selection,
      });
    });

    it("keeps what Settings already chose", () => {
      const chosen = {
        providerInstances: { opencode: { driver: "opencode", enabled: false } },
        defaultModelSelection: null,
        textGenerationModelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
      };
      expect(start(chosen)).toEqual(chosen);
    });
  });

  it("seeds supervised threads and no provider update checks", () => {
    const seed: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(deployRoot, "seed", "settings.json"), "utf8"),
    );
    expect(seed).toMatchObject({
      defaultRuntimeMode: "approval-required",
      enableProviderUpdateChecks: false,
    });
  });
});
