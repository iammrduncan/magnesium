// magnesium: tests for the strip, rename and merge scripts (doc 11).
import { describe, expect, it } from "vite-plus/test";

import { classifyConflict, parseUnmerged } from "./merge-rehearsal.ts";
import { newestStableTag } from "./merge-upstream.ts";
import { isRenameOwned, renameManifest, renameText } from "./rename-upstream.ts";
import {
  isStripped,
  patchPackageName,
  removeTestBlock,
  stripPatchedDependencies,
} from "./strip-upstream.ts";

describe("strip", () => {
  it("reads the package name from patch files and patchedDependencies keys", () => {
    expect(patchPackageName("@react-navigation%2Fnative-stack@7.17.6.patch")).toBe(
      "@react-navigation/native-stack",
    );
    expect(patchPackageName("@react-native-ai__apple@0.12.0.patch")).toBe("@react-native-ai/apple");
    expect(patchPackageName('"@clerk/expo@4.6.8"')).toBe("@clerk/expo");
    expect(patchPackageName("node-pty@1.2.0-beta.15")).toBe("node-pty");
  });

  it("strips the deleted apps and upstream workflows, and keeps ours", () => {
    expect(isStripped("apps/mobile/package.json")).toBe(true);
    expect(isStripped("infra/relay")).toBe(true);
    expect(isStripped(".github/workflows/release.yml")).toBe(true);
    expect(isStripped(".github/workflows/some-new-upstream-workflow.yml")).toBe(true);
    expect(isStripped(".github/workflows/magnesium-ci.yml")).toBe(false);
    expect(isStripped("patches/expo-blur@58.0.3.patch")).toBe(true);
    expect(isStripped("patches/node-pty@1.2.0-beta.15.patch")).toBe(false);
    expect(isStripped("apps/web/src/main.tsx")).toBe(false);
  });

  it("drops only stripped patchedDependencies, with the comment above them", () => {
    const source = [
      "packages:",
      "  - apps/*",
      "patchedDependencies:",
      '  "@effect/vitest@4.0.0-rc.115": patches/a.patch',
      "  expo-blur@58.0.3: patches/b.patch",
      "  # Why the markdown patch exists.",
      "  react-native-nitro-markdown@0.5.8: patches/c.patch",
      "  node-pty@1.2.0-beta.15: patches/d.patch",
      "",
      "peerDependencyRules:",
      "  expo-blur: keep-outside-the-block",
    ].join("\n");
    const stripped = stripPatchedDependencies(source);
    expect(stripped).toBe(
      [
        "packages:",
        "  - apps/*",
        "patchedDependencies:",
        '  "@effect/vitest@4.0.0-rc.115": patches/a.patch',
        "  node-pty@1.2.0-beta.15: patches/d.patch",
        "",
        "peerDependencyRules:",
        "  expo-blur: keep-outside-the-block",
      ].join("\n"),
    );
    expect(stripPatchedDependencies(stripped)).toBe(stripped);
  });

  it("removes one test block by title and leaves the rest", () => {
    const source = [
      'describe("x", () => {',
      '  it("reads the vendored GhosttyKit notice", async () => {',
      "    expect(1).toBe(1);",
      "  });",
      "",
      '  it("keeps this one", () => {});',
      "});",
    ].join("\n");
    const removed = removeTestBlock(source, "GhosttyKit notice");
    expect(removed).toBe(
      ['describe("x", () => {', '  it("keeps this one", () => {});', "});"].join("\n"),
    );
    expect(removeTestBlock(removed, "GhosttyKit notice")).toBe(removed);
  });
});

describe("rename", () => {
  it("renames what people see and keeps identifiers", () => {
    const source = 'const title = "T3 Code"; const key = "t3-code"; const env = "T3CODE_HOME";';
    expect(renameText("apps/web/src/x.ts", source)).toBe(
      'const title = "Magnesium"; const key = "t3-code"; const env = "T3CODE_HOME";',
    );
    expect(renameText("apps/web/index.html", "<title>T3 Code (Beta)</title>")).toBe(
      "<title>Magnesium</title>",
    );
    // Codex reports this name as each request's originator: an identity, kept.
    expect(
      renameText(
        "apps/server/src/provider/CodexProvider.ts",
        'const CODEX_CLIENT_NAME = "T3 Code";\nconst label = "T3 Code";',
      ),
    ).toBe('const CODEX_CLIENT_NAME = "T3 Code";\nconst label = "Magnesium";');
  });

  it("keeps agent-facing and inert server files out of the rename", () => {
    expect(isRenameOwned("apps/server/src/bin.ts")).toBe(true);
    expect(isRenameOwned("packages/provider-core/src/server/runtimeInstructions.ts")).toBe(false);
    expect(isRenameOwned("packages/provider-pi/src/server/status.ts")).toBe(true);
    expect(isRenameOwned("apps/server/src/mcp/McpHttpServer.ts")).toBe(false);
    expect(isRenameOwned("apps/web/public/favicon.ico")).toBe(true);
    expect(isRenameOwned("packages/contracts/src/settings.ts")).toBe(false);
  });

  it("names the web manifest and adds install icons once", () => {
    const manifest = JSON.stringify({
      id: "/",
      icons: [{ src: "/favicon-32x32.png", sizes: "32x32", type: "image/png" }],
    });
    const renamed = renameManifest(manifest);
    expect(JSON.parse(renamed)).toMatchObject({
      name: "Magnesium",
      short_name: "Magnesium",
      icons: [
        { src: "/favicon-32x32.png" },
        { src: "/icon-192.png", purpose: "any" },
        { src: "/icon-512.png", purpose: "any" },
        { src: "/icon-maskable-512.png", purpose: "maskable" },
      ],
    });
    expect(renameManifest(renamed)).toBe(renamed);
  });
});

describe("merge", () => {
  it("picks the newest stable tag and ignores nightlies and previews", () => {
    expect(
      newestStableTag([
        "v0.0.9",
        "v0.0.45",
        "v0.0.46-nightly.20261010.1",
        "v0.0.46-preview.20261010.2909",
        "",
      ]),
    ).toBe("v0.0.45");
  });

  it("reads unmerged entries from porcelain output", () => {
    const porcelain = [
      "UU apps/web/src/a.ts",
      "M  apps/server/src/b.ts",
      "DU apps/mobile/c.ts",
      "",
    ].join("\0");
    expect(parseUnmerged(porcelain)).toEqual([
      { status: "UU", file: "apps/web/src/a.ts" },
      { status: "DU", file: "apps/mobile/c.ts" },
    ]);
  });

  it("leaves a conflict to a person when the file has a hand-written edit", () => {
    expect(classifyConflict("apps/mobile/c.ts", false)).toBe("stripped");
    expect(classifyConflict("pnpm-lock.yaml", false)).toBe("regenerated");
    expect(classifyConflict("README.md", true)).toBe("ours");
    expect(classifyConflict("apps/server/src/bin.ts", false)).toBe("scripted");
    expect(classifyConflict("apps/server/src/bin.ts", true)).toBe("real");
    expect(classifyConflict("apps/server/src/mcp/McpHttpServer.ts", false)).toBe("real");
    // A hand edit in a file no comment can mark is merged by a person, not taken from upstream.
    expect(classifyConflict("apps/server/src/provider/model-manifest.json", false)).toBe("real");
  });
});
