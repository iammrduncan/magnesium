#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: fails when Magnesium's own content holds lab identifiers, private
// addresses or secret-shaped strings, so nothing about one deployment is published
// (MAGNESIUM.md, Rules).
//
//   node scripts/check-public.ts [--untracked] [--base <ref>]
//
// It checks Magnesium's content only: files upstream's base doesn't have, and the
// lines Magnesium adds to upstream's files. Upstream's own text and fixtures are
// upstream's. The base defaults to the watermark in upstream-changelog.md; a shallow
// clone fetches it with `git fetch --depth=1 origin <sha>`. It reads what Git would
// commit (the index), so stage new files first; `--untracked` adds untracked,
// non-ignored files from disk.
//
// Generic patterns live here. Lab identifiers live in a private denylist,
// .internal/public-denylist.txt (git-ignored), one regular expression per line: "#"
// starts a comment and a "cs:" prefix makes a pattern case-sensitive. Where
// .internal/ exists the denylist must too; a clone without it (CI, say) checks the
// generic patterns only. A line containing "public-check: allow" is skipped: use it
// sparingly, with a reason.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface Pattern {
  readonly label: string;
  readonly re: RegExp;
}

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly match: string;
}

const ALLOW_MARKER = "public-check: allow";

/** Files that name a person on purpose: the denylist doesn't apply to them. */
const NAMED_ON_PURPOSE = new Set(["LICENSE"]);

/** Vendored references, synced from their own repos. */
const SKIPPED_PREFIXES = [".repos/"];

// Addresses that may appear: unspecified, loopback and the documentation ranges.
const ALLOWED_IPV4 =
  /^(?:0\.0\.0\.0|127\.0\.0\.1|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<![\\d.])(?:${OCTET}\\.){3}${OCTET}(?![\\d.])`, "g");

export const GENERIC_PATTERNS: ReadonlyArray<Pattern> = [
  { label: "private IPv4 (10/8)", re: /\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/ },
  { label: "private IPv4 (172.16/12)", re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
  { label: "private IPv4 (192.168/16)", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  {
    label: "CGNAT IPv4 (100.64/10)",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  { label: "MAC address", re: /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i },
  { label: "private key block", re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    label: "API key shape",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tskey-[A-Za-z0-9-]{10,})\b/,
  },
];

/** Reads the private denylist; see the header for its format. */
export function parseDenylist(source: string): Array<Pattern> {
  const patterns: Array<Pattern> = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const caseSensitive = line.startsWith("cs:");
    const body = caseSensitive ? line.slice(3) : line;
    patterns.push({ label: "lab identifier", re: new RegExp(body, caseSensitive ? "" : "i") });
  }
  return patterns;
}

/** The hits in one line of a file, unless the line carries the allow marker. */
export function findHits(
  file: string,
  line: number,
  text: string,
  denylist: ReadonlyArray<Pattern>,
): Array<Hit> {
  if (text.includes(ALLOW_MARKER)) return [];
  const hits: Array<Hit> = [];
  const patterns = NAMED_ON_PURPOSE.has(file)
    ? GENERIC_PATTERNS
    : [...GENERIC_PATTERNS, ...denylist];
  for (const { label, re } of patterns) {
    const match = text.match(re);
    if (match) hits.push({ file, line, label, match: match[0] });
  }
  for (const match of text.matchAll(IPV4)) {
    if (!ALLOWED_IPV4.test(match[0]))
      hits.push({ file, line, label: "IPv4 address", match: match[0] });
  }
  return hits;
}

/** The added lines of a zero-context `git diff`, with their line numbers in the new file. */
export function addedLines(diff: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  let file: string | undefined;
  let next = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      file = text.startsWith("+++ b/") ? text.slice("+++ b/".length) : undefined;
    } else if (text.startsWith("@@ ")) {
      next = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    } else if (text.startsWith("+") && file !== undefined) {
      out.push({ file, line: next, text: text.slice(1) });
      next += 1;
    }
  }
  return out;
}

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "latin1",
    maxBuffer: 1024 * 1024 * 1024,
  });

const readFlag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

/** The last upstream commit fully inspected, from upstream-changelog.md. */
export function watermark(changelog: string): string | undefined {
  return /fully inspected:\*\* `([0-9a-f]{40})`/.exec(changelog)?.[1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = NodePath.resolve(import.meta.dirname, "..");
  const changelog = NodeFS.readFileSync(NodePath.join(root, "upstream-changelog.md"), "utf8");
  const base = readFlag(args, "--base") ?? watermark(changelog);
  if (base === undefined) {
    console.error("check-public: no watermark in upstream-changelog.md; pass --base <ref>.");
    process.exit(2);
  }
  try {
    git(root, ["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    console.error(`check-public: upstream base ${base} is not here.`);
    console.error(`Fetch it first: git fetch --no-tags --depth=1 origin ${base}`);
    process.exit(2);
  }

  const internalDir = NodePath.join(root, ".internal");
  const denylistPath = NodePath.join(internalDir, "public-denylist.txt");
  let denylist: Array<Pattern> = [];
  if (NodeFS.existsSync(denylistPath)) {
    denylist = parseDenylist(NodeFS.readFileSync(denylistPath, "utf8"));
  } else if (NodeFS.existsSync(internalDir)) {
    console.error(`check-public: private denylist missing (${denylistPath}).`);
    console.error(".internal/ exists, so its denylist must too.");
    process.exit(1);
  } else {
    console.warn("check-public: no private denylist here; checking generic patterns only.");
  }

  const skipped = (file: string) => SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix));
  // Staged content against the base: new files whole, upstream files by the lines we add.
  const diff = git(root, [
    "diff",
    "--cached",
    "--no-renames",
    "--diff-filter=d",
    "--text",
    "--no-color",
    "--no-ext-diff",
    "-U0",
    base,
  ]);
  const lines = addedLines(diff).filter(({ file }) => !skipped(file));
  if (args.includes("--untracked")) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter((file) => file !== "" && !skipped(file));
    for (const file of untracked) {
      const full = NodePath.join(root, file);
      if (!NodeFS.statSync(full).isFile()) continue;
      // latin1 keeps every byte, so identifiers inside binary files are found too.
      NodeFS.readFileSync(full, "latin1")
        .split("\n")
        .forEach((text, index) => lines.push({ file, line: index + 1, text }));
    }
  }

  const hits = lines.flatMap(({ file, line, text }) => findHits(file, line, text, denylist));
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.label}: ${hit.match}`);
  const files = new Set(lines.map(({ file }) => file)).size;
  if (hits.length > 0) {
    console.error(
      `check-public: ${hits.length} hit(s) in ${files} files. Remove lab specifics before committing.`,
    );
    process.exit(1);
  }
  const patterns = GENERIC_PATTERNS.length + denylist.length;
  console.log(`check-public: ok (${lines.length} lines in ${files} files, ${patterns} patterns)`);
}
