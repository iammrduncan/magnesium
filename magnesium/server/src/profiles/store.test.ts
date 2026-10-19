// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - fixtures write profile folders and read them back.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach } from "vite-plus/test";

import { InstanceSource, ProfilesConfig, REVISION_FILE } from "./catalog.ts";
import type { DetectedSetup } from "./setup.ts";
import { applySettings, pathProblem, ProfileStore, layer as storeLayer } from "./ProfileStore.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A hub's profiles folder, empty, and the store over it. */
const makeStore = () => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-store-")));
  roots.push(root);
  const folder = NodePath.join(root, "profiles");
  NodeFS.mkdirSync(folder, { recursive: true });
  const config: DetectedSetup = {
    folder,
    machine: "hub",
    isHub: true,
    setup: {
      stateHome: root,
      wrapperDir: undefined,
      binaries: { claude: undefined, codex: undefined, opencode: undefined },
      userHome: root,
      fence: { unavailable: "test" },
      container: { unavailable: "test" },
      protect: [],
    },
  };
  const layer = storeLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ProfilesConfig, ProfilesConfig.of(config)),
        Layer.succeed(InstanceSource, InstanceSource.of({ instances: Effect.succeed({}) })),
      ),
    ),
  );
  const read = (file: string) => NodeFS.readFileSync(NodePath.join(folder, file), "utf8");
  return { folder, layer, read };
};

describe("the profile store", () => {
  it.effect(
    "creates a profile that runs everywhere, saves a checked change, and refuses one that fails",
    () => {
      const { layer, read } = makeStore();
      return Effect.gen(function* () {
        const store = yield* ProfileStore;
        const created = yield* store.create(
          { name: "scratch-b", description: "Scratch work." },
          "You",
        );
        expect(created).toMatchObject({ saved: true, version: 1 });
        const fresh = yield* store.detail("scratch-b");
        expect(fresh).toMatchObject({ everyMachine: true, version: 1, editable: true });
        expect(fresh.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
        expect(fresh.history).toMatchObject([{ version: 1, by: "You", summary: "Created" }]);

        const saved = yield* store.save(
          {
            name: "scratch-b",
            settings: { machines: ["cpu-host-1", "cpu-host-2"] },
            files: [{ path: "CLAUDE.md", content: "End every reply with the word `ok-b`.\n" }],
          },
          "You",
        );
        expect(saved).toMatchObject({ saved: true, version: 2 });
        const changed = yield* store.detail("scratch-b");
        expect(changed.everyMachine).toBe(false);
        expect(changed.summary.machines).toEqual(["cpu-host-1", "cpu-host-2"]);
        expect(changed.files.map((file) => file.path)).toEqual(["AGENTS.md", "CLAUDE.md"]);
        expect(changed.history[0]).toMatchObject({ summary: "Changed CLAUDE.md, machines" });

        // A permission flag fails the check: nothing is written, and the version stays.
        const refused = yield* store.save(
          { name: "scratch-b", settings: { launchArgs: ["--dangerously-skip-permissions"] } },
          "You",
        );
        expect(refused).toMatchObject({ saved: false, version: 2 });
        expect(refused.issues.map((issue) => issue.message)).toContainEqual(
          expect.stringContaining("full access is a per-thread choice"),
        );
        expect(read("scratch-b/profile.yaml")).not.toContain("dangerously");
        expect((yield* store.detail("scratch-b")).version).toBe(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps every change as a version, and puts an earlier one back", () => {
    const { layer, folder } = makeStore();
    return Effect.gen(function* () {
      const store = yield* ProfileStore;
      yield* store.create({ name: "scratch-b" }, "You");
      yield* store.save(
        {
          name: "scratch-b",
          settings: { machines: ["cpu-host-1"] },
          files: [{ path: "RUNBOOK.md", content: "Roll back first.\n" }],
        },
        "research, approved by you",
      );
      const back = yield* store.putBack({ name: "scratch-b", version: 1 }, "You");
      expect(back).toMatchObject({ saved: true, version: 3 });
      const detail = yield* store.detail("scratch-b");
      expect(detail.everyMachine).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(folder, "scratch-b", "RUNBOOK.md"))).toBe(false);
      expect(detail.history.map((entry) => [entry.version, entry.by, entry.summary])).toEqual([
        [3, "You", "Put back v1"],
        [2, "research, approved by you", "Changed RUNBOOK.md, machines"],
        [1, "You", "Created"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a deleted profile for 30 days, and restores it with its history", () => {
    const { layer } = makeStore();
    return Effect.gen(function* () {
      const store = yield* ProfileStore;
      yield* store.create({ name: "scratch-b" }, "You");
      yield* store.save(
        { name: "scratch-b", files: [{ path: "CLAUDE.md", content: "Be brief.\n" }] },
        "You",
      );
      yield* store.remove("scratch-b", "You");
      expect((yield* store.detail("scratch-b").pipe(Effect.flip)).detail).toContain(
        "no profile named",
      );
      const [deleted] = yield* store.deleted;
      expect(deleted?.name).toBe("scratch-b");
      const days = (Date.parse(deleted!.expiresAt) - Date.parse(deleted!.deletedAt)) / 86_400_000;
      expect(days).toBe(30);

      yield* store.restore("scratch-b", "You");
      const restored = yield* store.detail("scratch-b");
      expect(restored.files.map((file) => file.path)).toContain("CLAUDE.md");
      expect(restored.history.map((entry) => entry.summary)).toEqual([
        "Changed CLAUDE.md",
        "Created",
      ]);
      expect(yield* store.deleted).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("makes a change made by hand a version when the profile is next read", () => {
    const { layer, folder } = makeStore();
    return Effect.gen(function* () {
      const store = yield* ProfileStore;
      yield* store.create({ name: "scratch-b" }, "You");
      NodeFS.writeFileSync(
        NodePath.join(folder, "scratch-b", "CONVENTIONS.md"),
        "Tabs, not spaces.\n",
      );
      const detail = yield* store.detail("scratch-b");
      expect(detail.history[0]).toMatchObject({
        version: 2,
        by: "On disk",
        summary: "Changed outside the app",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists MCP servers, Magnesium's own first, with each tool's permission", () => {
    const { layer, folder } = makeStore();
    return Effect.gen(function* () {
      const store = yield* ProfileStore;
      yield* store.create({ name: "serving" }, "You");
      yield* store.save(
        {
          name: "serving",
          files: [
            {
              path: "mcp.json",
              content: JSON.stringify({
                mcpServers: {
                  grafana: {
                    type: "http",
                    url: "https://grafana.example/mcp",
                    headers: { Authorization: "Bearer ${GRAFANA_TOKEN}" },
                  },
                },
              }),
            },
            {
              path: "skills/rollout-watch/SKILL.md",
              content: "---\ndescription: Watch a rollout.\n---\n",
            },
          ],
          settings: {
            toolPermissions: { grafana: { default: "ask", tools: { delete_dashboard: "off" } } },
          },
        },
        "You",
      );
      const detail = yield* store.detail("serving");
      expect(detail.mcpServers).toMatchObject([
        { name: "magnesium", permissions: { default: "allow" } },
        {
          name: "grafana",
          how: "https://grafana.example/mcp",
          secrets: ["GRAFANA_TOKEN"],
          permissions: { default: "ask", tools: { delete_dashboard: "off" } },
        },
      ]);
      expect(detail.skills).toMatchObject([
        { name: "rollout-watch", description: "Watch a rollout." },
      ]);
      expect(
        NodeFS.readFileSync(NodePath.join(folder, "serving", "profile.yaml"), "utf8"),
      ).toContain("tool_permissions:");

      // Going back to the defaults takes the server's entry out.
      yield* store.save(
        { name: "serving", settings: { toolPermissions: { grafana: null } } },
        "You",
      );
      expect(
        NodeFS.readFileSync(NodePath.join(folder, "serving", "profile.yaml"), "utf8"),
      ).not.toContain("tool_permissions");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "refuses paths outside a profile's files, removing AGENTS.md, and a machine's folder",
    () => {
      const { layer, folder } = makeStore();
      return Effect.gen(function* () {
        const store = yield* ProfileStore;
        yield* store.create({ name: "scratch-b" }, "You");
        const attempt = (path: string, content: string | null) =>
          store.save({ name: "scratch-b", files: [{ path, content }] }, "You").pipe(
            Effect.flip,
            Effect.map((error) => error.detail),
          );
        expect(yield* attempt("../escape.md", "x")).toContain("isn't a path inside the profile");
        expect(yield* attempt("profile.yaml", "x")).toContain("settings");
        expect(yield* attempt("notes/plan.md", "x")).toContain("skills/<skill>/");
        expect(yield* attempt("AGENTS.md", null)).toContain("can't be removed");

        // On a machine, the hub fills the folder: nothing changes here.
        NodeFS.writeFileSync(NodePath.join(folder, REVISION_FILE), "abc\n");
        expect(yield* attempt("CLAUDE.md", "x")).toContain("come from the hub");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("copies a profile under a new name, with its own display name", () => {
    const { layer, read } = makeStore();
    return Effect.gen(function* () {
      const store = yield* ProfileStore;
      yield* store.create({ name: "serving" }, "You");
      yield* store.save({ name: "serving", settings: { displayName: "Serving" } }, "You");
      const copy = yield* store.create({ name: "serving-b", copyOf: "serving" }, "You");
      expect(copy).toMatchObject({ saved: true, version: 1 });
      expect(read("serving-b/profile.yaml")).toContain("name: serving-b");
      expect(read("serving-b/profile.yaml")).not.toMatch(/^display_name:/m);
      expect((yield* store.detail("serving-b")).history[0]?.summary).toBe(
        "Created as a copy of serving",
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("a profile's files and settings", () => {
  it("allows its Markdown, mcp.json, hooks.json and skills, nothing else", () => {
    expect(pathProblem("RUNBOOK.md")).toBeUndefined();
    expect(pathProblem("mcp.json")).toBeUndefined();
    expect(pathProblem("skills/rollout-watch/scripts/run.sh")).toBeUndefined();
    expect(pathProblem(".magnesium/launch.env")).toContain("isn't a path");
    expect(pathProblem("skills/Bad Name/SKILL.md")).toContain("skills/<skill>/");
  });

  it("changes profile.yaml's settings and keeps its comments", () => {
    const before =
      '# My profile.\nname: serving\n# Where it runs.\nmachines: ["*"]\nharness: claude\n';
    const after = applySettings(before, {
      machines: ["gpu-a"],
      harnesses: ["claude", "codex"],
      sandbox: "container",
      accentColor: "#c2410c",
    });
    expect(after).toContain("# My profile.");
    expect(after).toContain("# Where it runs.\nmachines: [ gpu-a ]");
    expect(after).toContain("harnesses: [ claude, codex ]");
    expect(after).toContain("sandbox:\n  level: container");
    expect(after).toContain('accent: "#c2410c"');
  });
});
