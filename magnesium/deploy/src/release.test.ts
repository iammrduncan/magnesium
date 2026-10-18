// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the test ages release folders on disk and waits on a real build process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../bin/magnesium-release");
const toolShim = NodePath.resolve(import.meta.dirname, "../container/tool-shim");

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
    NodeFS.mkdirSync(NodePath.join(release, "magnesium/deploy/bin"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(release, "magnesium/deploy/bin/magnesium-fence"),
      "#!/bin/sh\n",
      {
        mode: 0o755,
      },
    );
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
  return { root, home, run, link, settings };
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

  it("pairs a device through the current release, at the hub's front door when it has one", () => {
    const release = makeRoot();
    expect(release.run("activate", "a").status).toBe(0);
    NodeFS.writeFileSync(
      NodePath.join(release.root, "releases/a/apps/server/dist/bin.mjs"),
      "console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.T3CODE_HOME }))",
    );
    const plain = JSON.parse(release.run("pair").stdout);
    expect(plain).toEqual({ args: ["pair", "--ttl", "15m"], home: release.home });

    NodeFS.writeFileSync(NodePath.join(release.home, "public-url"), "https://hub.example.test\n");
    const admin = JSON.parse(release.run("pair", "--admin").stdout);
    expect(admin.args).toEqual([
      "pair",
      "--ttl",
      "15m",
      "--admin",
      "--label",
      "admin device",
      "--base-url",
      "https://hub.example.test",
    ]);
    expect(release.run("pair", "--everything").status).toBe(1);
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

  it("prunes old releases, keeping current, previous, the newest few and any build in progress", () => {
    const release = makeRoot();
    release.run("activate", "a");
    release.run("activate", "b");
    // Older to newer: d, e, f. A build still running hides in .build-*.
    const hour = 3600;
    const now = Date.now() / 1000;
    ["d", "e", "f"].forEach((name, index) => {
      const dir = NodePath.join(release.root, "releases", name);
      NodeFS.mkdirSync(NodePath.join(dir, "apps/server/dist"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "apps/server/dist/bin.mjs"), "");
      const at = now - (3 - index) * hour;
      NodeFS.utimesSync(dir, at, at);
    });
    for (const name of ["a", "b"]) {
      const at = now - 10 * hour;
      NodeFS.utimesSync(NodePath.join(release.root, "releases", name), at, at);
    }
    NodeFS.mkdirSync(NodePath.join(release.root, "releases", ".build-123"));

    const result = release.run("prune");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed 1 old release(s).");
    expect(NodeFS.readdirSync(NodePath.join(release.root, "releases")).toSorted()).toEqual([
      ".build-123",
      "a",
      "b",
      "c",
      "e",
      "f",
    ]);
    expect(release.link("current")).toBe("releases/b");
    expect(release.link("previous")).toBe("releases/a");
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

  it("skips the clone when the pinned commit is already built", () => {
    const release = makeRoot();
    NodeFS.renameSync(
      NodePath.join(release.root, "releases", "a"),
      NodePath.join(release.root, "releases", "abcdef1234"),
    );
    const result = release.run("build", "abcdef1234567890", "/nonexistent/source");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("abcdef1234 is already built.");
  });

  it("packs a built release and unpacks it on a host that doesn't build", () => {
    const builder = makeRoot();
    // Stand-in for `pnpm --filter t3 deploy --prod --legacy <dir>`: it writes the server there.
    const fakePnpm = NodePath.join(builder.root, "fake-pnpm");
    NodeFS.writeFileSync(
      fakePnpm,
      '#!/bin/sh\nfor last; do :; done\nmkdir -p "$last/dist" && touch "$last/dist/bin.mjs"\n',
    );
    NodeFS.chmodSync(fakePnpm, 0o755);
    NodeFS.renameSync(
      NodePath.join(builder.root, "releases", "a"),
      NodePath.join(builder.root, "releases", "abcdef1234"),
    );
    const tarball = NodePath.join(builder.root, "release.tar.gz");
    const packed = NodeChildProcess.spawnSync("bash", [script, "pack", "abcdef1234", tarball], {
      encoding: "utf8",
      env: { ...process.env, MAGNESIUM_ROOT: builder.root, MAGNESIUM_PNPM: fakePnpm },
    });
    expect(packed.stderr).toBe("");
    expect(packed.status).toBe(0);

    const host = makeRoot();
    expect(host.run("unpack", tarball).status).toBe(0);
    const unpacked = NodePath.join(host.root, "releases", "abcdef1234");
    expect(NodeFS.existsSync(NodePath.join(unpacked, "apps/server/dist/bin.mjs"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(unpacked, "magnesium/deploy/seed/settings.json"))).toBe(
      true,
    );
    // The agent wrappers and the fence go with the server, executable.
    expect(
      NodeFS.statSync(NodePath.join(unpacked, "magnesium/deploy/bin/magnesium-fence")).mode & 0o111,
    ).not.toBe(0);
    expect(host.run("unpack", tarball).stdout).toContain("already unpacked");
    expect(host.run("activate", "abcdef1234").status).toBe(0);
    expect(host.link("current")).toBe("releases/abcdef1234");
  });

  it("refuses a tarball that is not a packed release", () => {
    const release = makeRoot();
    const junk = NodePath.join(release.root, "junk.tar.gz");
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      junk,
      "-C",
      NodePath.join(release.root, "releases"),
      "b",
    ]);
    const result = release.run("unpack", junk);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a packed release");
  });

  it("backs up a live database with its unflushed writes, and keeps only the newest copies", () => {
    const release = makeRoot();
    const userdata = NodePath.join(release.root, "state", "userdata");
    NodeFS.mkdirSync(NodePath.join(userdata, "logs"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(userdata, "logs", "server.trace.ndjson"), "{}");
    NodeFS.writeFileSync(NodePath.join(userdata, "server-runtime.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), '{"from":"state"}');
    // Held open like the running server: the row stays in the WAL, not state.sqlite.
    const live = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "state.sqlite"));
    live.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('kept')");
    // The server's lock, held as a running server holds it: no data, never copied.
    const owner = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "server-owner.sqlite"));
    owner.exec("BEGIN EXCLUSIVE");

    const runKeep = (keep: string) =>
      NodeChildProcess.spawnSync("bash", [script, "backup"], {
        encoding: "utf8",
        env: {
          ...process.env,
          MAGNESIUM_ROOT: release.root,
          MAGNESIUM_HOME: NodePath.join(release.root, "state"),
          MAGNESIUM_BACKUP_KEEP: keep,
        },
      });
    const first = runKeep("2");
    live.close();
    owner.close();
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);

    const backups = NodePath.join(release.root, "state", "backups");
    const [name = ""] = NodeFS.readdirSync(backups);
    const copy = NodePath.join(backups, name);
    expect(NodeFS.readdirSync(copy).toSorted()).toEqual(["settings.json", "state.sqlite"]);
    const restored = new NodeSqlite.DatabaseSync(NodePath.join(copy, "state.sqlite"));
    expect(restored.prepare("SELECT x FROM t").all()).toEqual([{ x: "kept" }]);
    restored.close();

    runKeep("2");
    runKeep("2");
    expect(NodeFS.readdirSync(backups)).toHaveLength(2);
  });

  it("restores a backup, and backs up the state it replaces first", () => {
    const release = makeRoot();
    const userdata = NodePath.join(release.root, "state", "userdata");
    NodeFS.mkdirSync(userdata, { recursive: true });
    const database = NodePath.join(userdata, "state.sqlite");
    const write = (value: string) => {
      const db = new NodeSqlite.DatabaseSync(database);
      db.exec(`CREATE TABLE IF NOT EXISTS t (x); DELETE FROM t; INSERT INTO t VALUES ('${value}')`);
      db.close();
      NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), `{"from":"${value}"}`);
    };
    const read = () => {
      const db = new NodeSqlite.DatabaseSync(database);
      const rows = db.prepare("SELECT x FROM t").all();
      db.close();
      return rows;
    };

    write("before");
    expect(release.run("backup").status).toBe(0);
    const backups = NodePath.join(release.root, "state", "backups");
    const [name = ""] = NodeFS.readdirSync(backups);
    write("after");

    const result = release.run("restore", name);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(read()).toEqual([{ x: "before" }]);
    expect(release.settings()).toBe('{"from":"before"}');
    expect(NodeFS.readdirSync(backups)).toHaveLength(2);

    expect(release.run("restore", "../userdata").status).not.toBe(0);
  });

  it("backs up the state before switching releases", () => {
    const release = makeRoot();
    release.run("activate", "a");
    expect(release.run("activate", "b").stdout).toContain("Backed up the state");
    expect(NodeFS.readdirSync(NodePath.join(release.root, "state", "backups"))).toHaveLength(1);
  });

  it("backs up an attached workload's state from a plain shell in its pod", () => {
    // The portable bundle as a workload mounts it: the tool shims in bin/, the
    // release in current/. A shell in the pod has the workload's own HOME, and
    // the server's home volume as MAGNESIUM_HOME, but none of the server's
    // other variables.
    const bundle = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "magnesium-bundle-"));
    roots.push(bundle);
    const deployBin = NodePath.join(bundle, "releases/x/magnesium/deploy/bin");
    NodeFS.mkdirSync(deployBin, { recursive: true });
    NodeFS.symlinkSync(script, NodePath.join(deployBin, "magnesium-release"));
    NodeFS.symlinkSync("releases/x", NodePath.join(bundle, "current"));
    NodeFS.mkdirSync(NodePath.join(bundle, "bin"));
    const tool = NodePath.join(bundle, "bin/magnesium-release");
    NodeFS.copyFileSync(toolShim, tool);
    NodeFS.chmodSync(tool, 0o755);
    const volume = NodePath.join(bundle, "volume");
    const workloadHome = NodePath.join(bundle, "workload");
    NodeFS.mkdirSync(NodePath.join(volume, ".magnesium/userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(volume, ".magnesium/userdata/settings.json"), "{}");
    NodeFS.mkdirSync(workloadHome);
    const shellEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["T3CODE_HOME", "MAGNESIUM_ROOT", "MAGNESIUM_NODE_BIN"].includes(name),
      ),
    );

    const result = NodeChildProcess.spawnSync(tool, ["backup"], {
      encoding: "utf8",
      env: { ...shellEnv, HOME: workloadHome, MAGNESIUM_HOME: volume },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const backups = NodePath.join(volume, ".magnesium/backups");
    const [name = ""] = NodeFS.readdirSync(backups);
    expect(NodeFS.readdirSync(NodePath.join(backups, name))).toEqual(["settings.json"]);
    expect(NodeFS.readdirSync(workloadHome)).toEqual([]);
  });

  it("waits for another build of the same commit on this host, then uses it", async () => {
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
    // Another deploy is building this commit here: its lock names a live process.
    const dest = NodePath.join(release.root, "releases", sha);
    const lock = NodePath.join(release.root, "releases", `.lock-${sha}`);
    NodeFS.mkdirSync(dest, { recursive: true });
    NodeFS.mkdirSync(lock);
    NodeFS.writeFileSync(NodePath.join(lock, "pid"), `${process.pid}\n`);

    const waiting = NodeChildProcess.spawn("bash", [script, "build", "main", repo], {
      env: { ...process.env, MAGNESIUM_ROOT: release.root, MAGNESIUM_BUILD_POLL: "1" },
    });
    let stdout = "";
    waiting.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => waiting.on("close", resolve));
    // The other build finishes: its server lands, and it lets go of the lock.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    NodeFS.mkdirSync(NodePath.join(dest, "apps/server/dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dest, "apps/server/dist/bin.mjs"), "");
    NodeFS.rmSync(lock, { recursive: true });

    expect(await exited).toBe(0);
    expect(stdout).toContain("waiting for it");
    expect(stdout).toContain(`${sha} is already built.`);
  });

  it("builds past a lock whose build is gone", () => {
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
    // A lock left by a build whose process has exited.
    const gone = NodeChildProcess.spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
    const lock = NodePath.join(release.root, "releases", `.lock-${sha}`);
    NodeFS.mkdirSync(lock, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(lock, "pid"), gone.stdout);
    const fakeVp = NodePath.join(release.root, "fake-vp");
    NodeFS.writeFileSync(
      fakeVp,
      "#!/bin/sh\nmkdir -p apps/server/dist && touch apps/server/dist/bin.mjs\n",
    );
    NodeFS.chmodSync(fakeVp, 0o755);

    const result = NodeChildProcess.spawnSync("bash", [script, "build", "main", repo], {
      encoding: "utf8",
      env: {
        ...process.env,
        MAGNESIUM_ROOT: release.root,
        MAGNESIUM_PNPM: "true",
        MAGNESIUM_VP: fakeVp,
        MAGNESIUM_BUILD_POLL: "1",
      },
    });
    // It waited on nothing: the stale lock goes, but the dead build left no folder,
    // so this one takes the lock and builds.
    expect(result.status).toBe(0);
    expect(
      NodeFS.existsSync(NodePath.join(release.root, "releases", sha, "apps/server/dist/bin.mjs")),
    ).toBe(true);
    expect(NodeFS.existsSync(lock)).toBe(false);
  });

  it("never deletes a release folder that another build is still filling", () => {
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
    // Another build's half-filled folder: no server yet.
    const inProgress = NodePath.join(release.root, "releases", sha);
    NodeFS.mkdirSync(inProgress, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(inProgress, "marker"), "still building");

    const result = release.run("build", "main", repo);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another build is running");
    expect(NodeFS.readFileSync(NodePath.join(inProgress, "marker"), "utf8")).toBe("still building");
  });
});
