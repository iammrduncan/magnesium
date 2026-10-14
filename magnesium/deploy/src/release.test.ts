// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../bin/magnesium-release");

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A release root with built releases `a` and `b`, and an unbuilt `c`. */
function makeRoot() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "magnesium-release-"));
  roots.push(root);
  for (const name of ["a", "b"]) {
    const release = NodePath.join(root, "releases", name);
    NodeFS.mkdirSync(NodePath.join(release, "apps/server/dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(release, "apps/server/dist/bin.mjs"), "");
    NodeFS.mkdirSync(NodePath.join(release, "magnesium/deploy/seed"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(release, "magnesium/deploy/seed/settings.json"),
      `{"from":"${name}"}`,
    );
  }
  NodeFS.mkdirSync(NodePath.join(root, "releases", "c"), { recursive: true });
  const home = NodePath.join(root, "state");
  const run = (...args: Array<string>) =>
    NodeChildProcess.spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, MAGNESIUM_ROOT: root, MAGNESIUM_HOME: home, MAGNESIUM_RESTART: "0" },
    });
  const link = (name: string) => {
    try {
      return NodeFS.readlinkSync(NodePath.join(root, name));
    } catch {
      return undefined;
    }
  };
  const settings = () => NodeFS.readFileSync(NodePath.join(home, "userdata/settings.json"), "utf8");
  return { root, run, link, settings };
}

describe("magnesium-release", () => {
  it("rolls back to the previous release in one command, and forward again", () => {
    const release = makeRoot();
    expect(release.run("activate", "a").status).toBe(0);
    expect(release.link("current")).toBe("releases/a");
    expect(release.link("previous")).toBeUndefined();

    expect(release.run("activate", "b").status).toBe(0);
    expect([release.link("current"), release.link("previous")]).toEqual([
      "releases/b",
      "releases/a",
    ]);

    expect(release.run("rollback").status).toBe(0);
    expect([release.link("current"), release.link("previous")]).toEqual([
      "releases/a",
      "releases/b",
    ]);

    expect(release.run("rollback").status).toBe(0);
    expect(release.link("current")).toBe("releases/b");
  });

  it("refuses a release that is not built, and keeps the current one", () => {
    const release = makeRoot();
    release.run("activate", "a");
    const result = release.run("activate", "c");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not built");
    expect(release.link("current")).toBe("releases/a");
  });

  it("refuses a rollback when there is nothing to go back to", () => {
    const release = makeRoot();
    release.run("activate", "a");
    expect(release.run("rollback").status).not.toBe(0);
    expect(release.link("current")).toBe("releases/a");
  });

  it("seeds settings once and never overwrites them", () => {
    const release = makeRoot();
    release.run("activate", "a");
    expect(release.settings()).toBe('{"from":"a"}');
    release.run("activate", "b");
    expect(release.settings()).toBe('{"from":"a"}');
  });

  it("builds a branch from a bundle that has no local branches", () => {
    const release = makeRoot();
    const repo = NodePath.join(release.root, "repo");
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    NodeFS.mkdirSync(repo);
    git("init", "--quiet", "--initial-branch=main");
    NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "x");
    git("add", "README.md");
    git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--quiet", "-m", "x");
    const sha = git("rev-parse", "--short=10", "HEAD").trim();
    const bundle = NodePath.join(release.root, "repo.bundle");
    git("bundle", "create", "--quiet", bundle, "main");
    // Stand-ins for the install and the build: the build writes the server entry.
    const fakeVp = NodePath.join(release.root, "fake-vp");
    NodeFS.writeFileSync(
      fakeVp,
      "#!/bin/sh\nmkdir -p apps/server/dist && touch apps/server/dist/bin.mjs\n",
    );
    NodeFS.chmodSync(fakeVp, 0o755);

    const result = NodeChildProcess.spawnSync("bash", [script, "build", "main", bundle], {
      encoding: "utf8",
      env: {
        ...process.env,
        MAGNESIUM_ROOT: release.root,
        MAGNESIUM_PNPM: "true",
        MAGNESIUM_VP: fakeVp,
      },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(
      NodeFS.existsSync(NodePath.join(release.root, "releases", sha, "apps/server/dist/bin.mjs")),
    ).toBe(true);
  });
});
