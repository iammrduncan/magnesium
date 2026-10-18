#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: merges an upstream T3 Code release into the fork (doc 11, sync policy).
//
//   node scripts/merge-upstream.ts [--ref <tag>] [--skip-checks]
//   node scripts/merge-upstream.ts --continue [--skip-checks]
//
// 1. Merges `--ref` (default: upstream's newest stable tag) with --no-commit.
// 2. Takes upstream's side of the lockfile, the generated route tree and the
//    files only the scripts edit, keeps ours for files we replaced outright
//    (the README), and drops conflicts in stripped paths.
// 3. Re-runs the strip and rename scripts.
// 4. Stops if real conflicts remain. Resolve them, `git add` them, and run
//    again with --continue.
// 5. Regenerates the lockfile and the route tree, then runs typecheck and the
//    tests unless --skip-checks.
// The merge is left uncommitted for review; log it in upstream-changelog.md.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { classifyConflict, hasMarkerAtHead, parseUnmerged } from "./merge-rehearsal.ts";
import { renameUpstream } from "./rename-upstream.ts";
import { stripUpstream } from "./strip-upstream.ts";

const repo = NodePath.resolve(import.meta.dirname, "..");

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { allowFailure?: boolean },
) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && options?.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
};

const runInherit = (command: string, args: ReadonlyArray<string>) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, { cwd: repo, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const git = (args: ReadonlyArray<string>) => run("git", args).stdout;

/** The newest `vX.Y.Z` tag, ignoring nightly and preview tags. */
export function newestStableTag(tags: ReadonlyArray<string>): string | undefined {
  const parse = (tag: string) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
  return tags
    .filter((tag) => parse(tag) !== undefined)
    .toSorted((a, b) => {
      const [x, y] = [parse(a)!, parse(b)!];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    })
    .at(-1);
}

const unmergedFiles = () => parseUnmerged(git(["status", "--porcelain=v1", "-z"]));

const readFlag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function startMerge(ref: string) {
  if (git(["status", "--porcelain"]).trim() !== "") {
    throw new Error("The working tree has changes. Commit or stash them first.");
  }
  const merge = run("git", ["merge", "--no-commit", "--no-ff", ref], { allowFailure: true });
  console.log(merge.stdout);
  const real: Array<string> = [];
  for (const { status, file } of unmergedFiles()) {
    const kind = classifyConflict(file, hasMarkerAtHead(repo, file));
    if (kind === "real") {
      real.push(file);
      continue;
    }
    // A side that deleted the file has no version to check out: take the deletion.
    // Our own deletion always stands, even of a file the scripts otherwise own.
    const side = kind === "ours" ? "ours" : "theirs";
    const deleted = status.startsWith("D") || (side === "theirs" && status.endsWith("D"));
    if (kind === "stripped" || deleted) {
      run("git", ["rm", "-r", "-f", "--quiet", "--", file], { allowFailure: true });
    } else if (status === "AU" || status === "UA") {
      // Added on one side only, such as into a folder the other side renamed: keep it.
      run("git", ["add", "--", file]);
    } else {
      run("git", ["checkout", `--${side}`, "--", file]);
      run("git", ["add", "--", file]);
    }
  }
  stripUpstream(repo);
  renameUpstream(repo);
  // Stage what the scripts changed, by name: staging a real conflict would mark
  // it resolved, markers and all, and `git add -A` with an exclude still does.
  const changed = git([
    "ls-files",
    "-z",
    "--modified",
    "--deleted",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter((file) => file !== "" && !real.includes(file));
  // An empty list would mean `git add -A` on the whole tree.
  if (changed.length === 0) return;
  const add = NodeChildProcess.spawnSync(
    "git",
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    { cwd: repo, input: [...new Set(changed)].join("\0"), encoding: "utf8" },
  );
  if (add.status !== 0) throw new Error(`git add failed:\n${add.stderr}`);
}

function finish(skipChecks: boolean) {
  const remaining = unmergedFiles();
  if (remaining.length > 0) {
    console.log("\nResolve these conflicts, `git add` them, then run with --continue:");
    for (const { status, file } of remaining) console.log(`  ${status} ${file}`);
    process.exitCode = 1;
    return;
  }
  // The lockfile and the route tree are regenerated rather than merged.
  runInherit("vp", ["install", "--no-frozen-lockfile"]);
  runInherit("vp", ["run", "--filter", "@t3tools/web", "build"]);
  run("git", ["add", "--", "pnpm-lock.yaml", "apps/web/src/routeTree.gen.ts"]);
  if (!skipChecks) {
    runInherit("vp", ["run", "-r", "--concurrency-limit", "2", "typecheck"]);
    runInherit("vp", ["run", "-r", "test"]);
  }
  const head = git(["rev-parse", "MERGE_HEAD"]).trim();
  console.log(`\nMerge of ${head.slice(0, 10)} is staged. Review it, then commit, for example:`);
  console.log("  git commit -m 'chore: merge upstream <tag>'");
  console.log("In the same commit, add the merge to upstream-changelog.md and move its watermark.");
  console.log("Then record the merge cost: node scripts/upstream-edits.ts");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const skipChecks = args.includes("--skip-checks");
  if (!args.includes("--continue")) {
    run("git", ["fetch", "--tags", "upstream"]);
    const ref =
      readFlag(args, "--ref") ?? newestStableTag(git(["tag", "--list", "v*"]).split("\n"));
    if (ref === undefined) throw new Error("No stable upstream tag found.");
    console.log(`Merging ${ref}`);
    startMerge(ref);
  }
  finish(skipChecks);
}
