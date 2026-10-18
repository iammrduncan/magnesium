#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: lists every `magnesium:` marker in files that also exist upstream,
// so the cost of our edits to upstream files stays visible (doc 11).
//
//   node scripts/upstream-edits.ts [--base <ref>] [--check] [--json]
//
// `--base` is the upstream commit the fork is built on; it defaults to the
// merge base of HEAD and `upstream/main`. `--check` also lists upstream files
// changed since the base without a marker, and exits 1 when there are any.
// Files the strip and rename scripts own are reported apart: those scripts
// re-apply them after each merge, so they carry no hand-written markers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REGENERATED_FILES } from "./merge-rehearsal.ts";
import { isRenameOwned } from "./rename-upstream.ts";
import { isStripped, STRIP_PATCHED_FILES } from "./strip-upstream.ts";

const MARKER = "magnesium:";

/** Hand edits in files that cannot hold a comment, with what each one does. */
export const UNMARKABLE_EDITS: Readonly<Record<string, string>> = {
  LICENSE: "adds the copyright line for Magnesium's own work",
  "package.json": "adds check:public (scripts/check-public.ts)",
  "apps/server/package.json": "adds @magnesium/server (doc 11)",
  "apps/web/package.json":
    "drops @clerk/electron and @clerk/react (D13); adds @magnesium/web and @magnesium/contracts (doc 11)",
};

export interface MarkedEdit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface UpstreamEditsReport {
  readonly base: string;
  readonly marked: ReadonlyArray<MarkedEdit>;
  readonly scriptOwned: ReadonlyArray<string>;
  readonly regenerated: ReadonlyArray<string>;
  readonly unmarkable: ReadonlyArray<string>;
  readonly unmarked: ReadonlyArray<string>;
}

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

const lines = (output: string): Array<string> => output.split("\n").filter((line) => line !== "");

/** Collects marked, script-owned and unmarked edits to upstream files. */
export function collectUpstreamEdits(cwd: string, base: string): UpstreamEditsReport {
  const upstreamFiles = new Set(lines(git(cwd, ["ls-tree", "-r", "--name-only", base])));
  // `git grep` exits 1 when nothing matches.
  let grepOutput = "";
  try {
    grepOutput = git(cwd, ["grep", "-n", "-I", "-F", MARKER, "HEAD", "--"]);
  } catch {
    grepOutput = "";
  }
  const marked: Array<MarkedEdit> = [];
  for (const hit of lines(grepOutput)) {
    // HEAD:<file>:<line>:<text>
    const match = /^HEAD:(.+?):(\d+):(.*)$/.exec(hit);
    if (match === null) continue;
    const [, file, line, text] = match;
    if (file === undefined || line === undefined || text === undefined) continue;
    if (!upstreamFiles.has(file)) continue;
    marked.push({ file, line: Number(line), text: text.trim() });
  }
  const markedFiles = new Set(marked.map((edit) => edit.file));
  const changed = lines(git(cwd, ["diff", "--name-only", "--diff-filter=M", base, "HEAD", "--"]));
  const scriptOwned = changed.filter(
    (file) => isRenameOwned(file) || STRIP_PATCHED_FILES.includes(file),
  );
  const regenerated = changed.filter((file) => REGENERATED_FILES.includes(file));
  const unmarkable = changed.filter((file) => UNMARKABLE_EDITS[file] !== undefined);
  const unmarked = changed.filter(
    (file) =>
      !markedFiles.has(file) &&
      !scriptOwned.includes(file) &&
      !regenerated.includes(file) &&
      !unmarkable.includes(file) &&
      !isStripped(file),
  );
  return { base, marked, scriptOwned, regenerated, unmarkable, unmarked };
}

export function formatUpstreamEdits(report: UpstreamEditsReport, check: boolean): string {
  const out: Array<string> = [];
  const files = [...new Set(report.marked.map((edit) => edit.file))];
  out.push(`Marked edits to upstream files (base ${report.base.slice(0, 10)}):`);
  out.push(`${report.marked.length} markers in ${files.length} files`);
  for (const file of files) {
    out.push("", file);
    for (const edit of report.marked.filter((candidate) => candidate.file === file)) {
      out.push(`  ${edit.line}: ${edit.text}`);
    }
  }
  out.push("", `Edited by the strip and rename scripts (${report.scriptOwned.length} files):`);
  for (const file of report.scriptOwned) out.push(`  ${file}`);
  out.push("", `Edits in files that cannot hold a marker (${report.unmarkable.length}):`);
  for (const file of report.unmarkable) out.push(`  ${file}: ${UNMARKABLE_EDITS[file]}`);
  out.push("", `Regenerated (${report.regenerated.length}): ${report.regenerated.join(", ")}`);
  if (check) {
    out.push("", `Changed upstream files without a marker (${report.unmarked.length}):`);
    for (const file of report.unmarked) out.push(`  ${file}`);
  }
  return out.join("\n");
}

const readFlag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cwd = NodePath.resolve(import.meta.dirname, "..");
  const base = readFlag(args, "--base") ?? git(cwd, ["merge-base", "HEAD", "upstream/main"]).trim();
  const check = args.includes("--check");
  const report = collectUpstreamEdits(cwd, base);
  const output = args.includes("--json")
    ? JSON.stringify(report, null, 2)
    : formatUpstreamEdits(report, check);
  const outFile = readFlag(args, "--out");
  if (outFile === undefined) {
    console.log(output);
  } else {
    NodeFS.writeFileSync(outFile, `${output}\n`);
  }
  if (check && report.unmarked.length > 0) process.exitCode = 1;
}
