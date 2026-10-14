#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off
// magnesium: renames what a person sees from T3 Code to Magnesium (doc 11's
// rename policy). Re-run after every merge from upstream; a second run changes
// nothing.
//
//   node scripts/rename-upstream.ts [--check]
//
// `--check` changes nothing and exits 1 if a run would change a file.
//
// It keeps `@t3tools/*`, `T3CODE_*`, `~/.t3`, the `t3` binary, the HTTP and
// WebSocket paths, the `t3-code` MCP key and `t3-context://` links: none of
// them contain the literal "T3 Code". Text an agent reads (prompts, MCP tool
// descriptions) keeps upstream's name, so agents behave as upstream tests them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repo = NodePath.resolve(import.meta.dirname, "..");

const FROM = "T3 Code";
const TO = "Magnesium";

/** Files and folders whose "T3 Code" text becomes "Magnesium". */
const RENAME_SCOPE = [
  "apps/web/src",
  "apps/web/index.html",
  "apps/server/src",
  "packages/shared/src/codexAuthCallback.ts",
  "packages/client-runtime/src/connection/compatibility.ts",
];

/** Inside the scope, but read by agents, stored as identity, or inert here. */
const RENAME_EXCLUDED = [
  "apps/server/src/textGeneration",
  "apps/server/src/mcp",
  "apps/server/src/provider/CodexDeveloperInstructions.ts",
  "apps/server/src/provider/RuntimeInstructions.ts",
  "apps/server/src/vcs/GitVcsDriver.ts",
  "apps/server/src/cli/triagePrompt.ts",
  "apps/server/src/project/NewProject.ts",
  "apps/server/src/cloud",
  "apps/server/src/relay",
  "apps/server/src/desktopUpdate",
];

/** Exact replacements applied before the plain rename. */
const EXACT_REPLACEMENTS: ReadonlyArray<{ file: string; from: string; to: string }> = [
  {
    file: "apps/web/index.html",
    from: "<title>T3 Code (Alpha)</title>",
    to: "<title>Magnesium</title>",
  },
];

/** Our "Mg" icons (scripts/magnesium-icons.ts) copied over upstream's. */
const ICON_COPIES: ReadonlyArray<{ from: string; to: ReadonlyArray<string> }> = [
  {
    from: "magnesium/web/assets/favicon.ico",
    to: ["apps/web/public/favicon.ico", "assets/dev/blueprint-web-favicon.ico"],
  },
  {
    from: "magnesium/web/assets/favicon-16x16.png",
    to: ["apps/web/public/favicon-16x16.png", "assets/dev/blueprint-web-favicon-16x16.png"],
  },
  {
    from: "magnesium/web/assets/favicon-32x32.png",
    to: ["apps/web/public/favicon-32x32.png", "assets/dev/blueprint-web-favicon-32x32.png"],
  },
  {
    from: "magnesium/web/assets/apple-touch-icon.png",
    to: ["apps/web/public/apple-touch-icon.png", "assets/dev/blueprint-web-apple-touch-180.png"],
  },
  { from: "magnesium/web/assets/icon-192.png", to: ["apps/web/public/icon-192.png"] },
  { from: "magnesium/web/assets/icon-512.png", to: ["apps/web/public/icon-512.png"] },
];

const MANIFEST = "apps/web/public/manifest.webmanifest";

const TEXT_EXTENSIONS = [".ts", ".tsx", ".html"];

const isWithin = (file: string, paths: ReadonlyArray<string>) =>
  paths.some((path) => file === path || file.startsWith(`${path}/`));

/** True for files this script edits, which therefore carry no hand markers. */
export function isRenameOwned(file: string): boolean {
  if (file === MANIFEST) return true;
  if (ICON_COPIES.some((copy) => copy.to.includes(file))) return true;
  return isWithin(file, RENAME_SCOPE) && !isWithin(file, RENAME_EXCLUDED);
}

const walk = (relative: string): Array<string> => {
  const absolute = NodePath.join(repo, relative);
  if (!NodeFS.existsSync(absolute)) return [];
  if (NodeFS.statSync(absolute).isFile()) return [relative];
  return NodeFS.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "node_modules" ? [] : walk(NodePath.join(relative, entry.name)),
  );
};

/** The manifest with Magnesium's name and install icons. */
export function renameManifest(source: string): string {
  const manifest = JSON.parse(source) as {
    name?: string;
    short_name?: string;
    icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };
  const icons = (manifest.icons ?? []).filter(
    (icon) => icon.src !== "/icon-192.png" && icon.src !== "/icon-512.png",
  );
  const next = {
    name: TO,
    short_name: TO,
    ...manifest,
    icons: [
      ...icons,
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
  next.name = TO;
  next.short_name = TO;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function renameText(file: string, source: string): string {
  let text = source;
  for (const replacement of EXACT_REPLACEMENTS) {
    if (replacement.file === file) text = text.replaceAll(replacement.from, replacement.to);
  }
  return text.replaceAll(FROM, TO);
}

/** Applies the rename and returns the files it changed (or would change). */
export function renameUpstream(root: string = repo, options?: { check?: boolean }): Array<string> {
  const changed: Array<string> = [];
  const write = (file: string, next: string | Buffer) => {
    const absolute = NodePath.join(root, file);
    const current = NodeFS.existsSync(absolute) ? NodeFS.readFileSync(absolute) : undefined;
    const nextBuffer = typeof next === "string" ? Buffer.from(next) : next;
    if (current !== undefined && current.equals(nextBuffer)) return;
    changed.push(file);
    if (options?.check !== true) {
      NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
      NodeFS.writeFileSync(absolute, nextBuffer);
    }
  };

  for (const file of RENAME_SCOPE.flatMap(walk)) {
    if (isWithin(file, RENAME_EXCLUDED)) continue;
    if (!TEXT_EXTENSIONS.includes(NodePath.extname(file))) continue;
    const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    write(file, renameText(file, source));
  }

  const manifestPath = NodePath.join(root, MANIFEST);
  if (NodeFS.existsSync(manifestPath)) {
    write(MANIFEST, renameManifest(NodeFS.readFileSync(manifestPath, "utf8")));
  }

  for (const copy of ICON_COPIES) {
    const icon = NodeFS.readFileSync(NodePath.join(root, copy.from));
    for (const target of copy.to) write(target, icon);
  }
  return changed;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const changed = renameUpstream(repo, { check });
  const verb = check ? "Would change" : "Changed";
  console.log(`${verb} ${changed.length} files.`);
  for (const file of changed) console.log(`  ${file}`);
  if (check && changed.length > 0) process.exitCode = 1;
}
