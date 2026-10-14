// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const deployRoot = NodePath.resolve(import.meta.dirname, "..");

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
