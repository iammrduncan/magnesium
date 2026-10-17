#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// magnesium: removes what Magnesium does not ship (doc 11, Strip; D10, D13).
// Re-run after every merge from upstream; a second run changes nothing.
//
//   node scripts/strip-upstream.ts [--check]
//
// `--check` changes nothing and exits 1 if a run would change something.
//
// It deletes the mobile, desktop and marketing apps, the relay, every upstream
// CI workflow (ours are the KEPT_WORKFLOWS), and the release scripts that need
// the deleted apps. It then patches the few kept files that point at them.
// After a run that changed pnpm-workspace.yaml, regenerate the lockfile with
// `vp install --no-frozen-lockfile`; scripts/merge-upstream.ts does this.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repo = NodePath.resolve(import.meta.dirname, "..");

const STRIPPED_DIRECTORIES = [
  "apps/mobile",
  "apps/desktop",
  "apps/marketing",
  "infra/relay",
  ".github/scripts",
  ".github/actions/setup-apt-mirrors",
];

/** Kept files that read the deleted apps, and release tooling built on them. */
const STRIPPED_FILES = [
  "apps/server/test/ActivityPayloadProjection.test.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/build-desktop-artifact.test.ts",
  "scripts/build-cli-archive.ts",
  "scripts/smoke-cli-archive.ts",
  "scripts/build-npm-platform-packages.ts",
  "scripts/build-npm-platform-packages.test.ts",
  "scripts/release-smoke.ts",
  "scripts/legend-list-initial-reveal.test.ts",
  // Upstream's release announcements, read from its deleted release workflow.
  "scripts/notify-discord-release.ts",
  "scripts/notify-discord-release.test.ts",
];

const WORKFLOWS_DIR = ".github/workflows";
/** Our workflows. Every other workflow is upstream's and is deleted. */
export const KEPT_WORKFLOWS = ["magnesium-ci.yml", "merge-rehearsal.yml"];

/** Patched packages only the deleted apps install. pnpm fails on unused patches. */
const STRIPPED_PATCH_PACKAGE =
  /^(alchemy|dbus-next|uniwind|expo-.*|@expo\/.*|@clerk\/expo|@react-native.*|@react-navigation\/.*|react-native.*)$/;

/** The package a `patches/` file or a `patchedDependencies` key is for. */
export function patchPackageName(entry: string): string {
  const name = entry
    .replace(/^"|"$/g, "")
    .replace(/\.patch$/, "")
    .replace(/%2F/g, "/")
    .replace(/__/g, "/");
  const versionAt = name.lastIndexOf("@");
  return versionAt > 0 ? name.slice(0, versionAt) : name;
}

const isWithin = (file: string, paths: ReadonlyArray<string>) =>
  paths.some((path) => file === path || file.startsWith(`${path}/`));

/** True for every path the strip deletes. */
export function isStripped(file: string): boolean {
  if (isWithin(file, STRIPPED_DIRECTORIES) || STRIPPED_FILES.includes(file)) return true;
  if (file.startsWith(`${WORKFLOWS_DIR}/`)) {
    return !KEPT_WORKFLOWS.includes(file.slice(WORKFLOWS_DIR.length + 1));
  }
  if (file.startsWith("patches/") && file.endsWith(".patch")) {
    return STRIPPED_PATCH_PACKAGE.test(patchPackageName(file.slice("patches/".length)));
  }
  return false;
}

/** Kept files the strip edits; they carry no hand markers for these edits. */
export const STRIP_PATCHED_FILES = [
  "apps/web/vite.config.ts",
  "scripts/lib/third-party-licenses.test.ts",
  "pnpm-workspace.yaml",
];

/** Drops `patchedDependencies` entries (and the comment above each) for stripped packages. */
export function stripPatchedDependencies(source: string): string {
  const lines = source.split("\n");
  const out: Array<string> = [];
  let inBlock = false;
  let pendingComments: Array<string> = [];
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inBlock = line.startsWith("patchedDependencies:");
      out.push(...pendingComments, line);
      pendingComments = [];
      continue;
    }
    if (!inBlock) {
      out.push(line);
      continue;
    }
    if (/^\s+#/.test(line)) {
      pendingComments.push(line);
      continue;
    }
    const key = /^\s+("[^"]+"|[^:\s]+):/.exec(line)?.[1];
    if (key !== undefined && STRIPPED_PATCH_PACKAGE.test(patchPackageName(key))) {
      pendingComments = [];
      continue;
    }
    out.push(...pendingComments, line);
    pendingComments = [];
  }
  out.push(...pendingComments);
  return out.join("\n");
}

/** Removes the `it(...)` block whose title contains `title`, if present. */
export function removeTestBlock(source: string, title: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s*it\(/.test(line) && line.includes(title));
  if (start === -1) return source;
  const indent = /^\s*/.exec(lines[start]!)![0];
  const end = lines.findIndex((line, index) => index > start && line === `${indent}});`);
  if (end === -1) return source;
  const trailingBlank = lines[end + 1] === "" ? 1 : 0;
  return [...lines.slice(0, start), ...lines.slice(end + 1 + trailingBlank)].join("\n");
}

const CONTENT_PATCHES: ReadonlyArray<{ file: string; apply: (source: string) => string }> = [
  {
    // The web build reads the desktop manifest for its licence notices.
    file: "apps/web/vite.config.ts",
    apply: (source) =>
      source
        .split("\n")
        .filter((line) => !line.includes("../desktop/package.json"))
        .join("\n"),
  },
  {
    file: "scripts/lib/third-party-licenses.test.ts",
    apply: (source) => removeTestBlock(source, "GhosttyKit notice"),
  },
  { file: "pnpm-workspace.yaml", apply: stripPatchedDependencies },
];

const listFiles = (root: string, relative: string): Array<string> => {
  const absolute = NodePath.join(root, relative);
  if (!NodeFS.existsSync(absolute)) return [];
  return NodeFS.readdirSync(absolute).map((name) => `${relative}/${name}`);
};

/** Applies the strip and returns what it changed (or would change). */
export function stripUpstream(root: string = repo, options?: { check?: boolean }): Array<string> {
  const changed: Array<string> = [];
  const candidates = [
    ...STRIPPED_DIRECTORIES,
    ...STRIPPED_FILES,
    ...listFiles(root, WORKFLOWS_DIR),
    ...listFiles(root, "patches"),
  ];
  for (const path of candidates) {
    if (!isStripped(path) || !NodeFS.existsSync(NodePath.join(root, path))) continue;
    changed.push(path);
    if (options?.check !== true) {
      NodeFS.rmSync(NodePath.join(root, path), { recursive: true, force: true });
    }
  }
  for (const patch of CONTENT_PATCHES) {
    const absolute = NodePath.join(root, patch.file);
    if (!NodeFS.existsSync(absolute)) continue;
    const source = NodeFS.readFileSync(absolute, "utf8");
    const next = patch.apply(source);
    if (next === source) continue;
    changed.push(patch.file);
    if (options?.check !== true) NodeFS.writeFileSync(absolute, next);
  }
  return changed;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const changed = stripUpstream(repo, { check });
  const verb = check ? "Would change" : "Changed";
  console.log(`${verb} ${changed.length} paths.`);
  for (const path of changed) console.log(`  ${path}`);
  if (check && changed.length > 0) process.exitCode = 1;
}
