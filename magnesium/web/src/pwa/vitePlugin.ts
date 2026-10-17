// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { build, type Plugin } from "vite-plus";

import { type BuildManifestChunk, SHELL_PATH, shellPrecacheList } from "./policy.ts";

const WORKER_ENTRY = NodePath.join(import.meta.dirname, "sw.ts");

/**
 * Writes the shell service worker, `sw.js`, into a production web build
 * (goal 05). After the app is built it reads Vite's manifest for the files
 * the app boots with, and bundles `sw.ts` as a classic script with them, the
 * entry, and a version hashed from the build. Dev builds get no worker.
 */
export function shellServiceWorkerPlugin(): Plugin {
  let outDir = "";
  let failed = false;
  return {
    name: "magnesium:shell-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
    },
    buildEnd(error) {
      failed = error !== undefined;
    },
    async closeBundle() {
      // A failed build wrote no manifest; leave its own error to be reported.
      if (failed) return;
      const manifestText = NodeFS.readFileSync(
        NodePath.join(outDir, ".vite", "manifest.json"),
        "utf8",
      );
      const manifest = JSON.parse(manifestText) as Record<string, BuildManifestChunk>;
      const entry = Object.values(manifest).find((chunk) => chunk.isEntry)?.file;
      if (entry === undefined) throw new Error("The web build has no entry chunk.");
      const rootFiles = NodeFS.readdirSync(outDir, { withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        .map((dirent) => dirent.name);
      const precache = shellPrecacheList(manifest, rootFiles);

      const version = NodeCrypto.createHash("sha256").update(manifestText);
      for (const path of precache) {
        const file = path === SHELL_PATH ? "index.html" : path.slice(1);
        version.update(path).update(NodeFS.readFileSync(NodePath.join(outDir, file)));
      }

      const output = await build({
        configFile: false,
        root: NodePath.dirname(WORKER_ENTRY),
        publicDir: false,
        logLevel: "warn",
        define: {
          __MAGNESIUM_SW_VERSION__: JSON.stringify(version.digest("hex").slice(0, 16)),
          __MAGNESIUM_SW_PRECACHE__: JSON.stringify(precache),
          __MAGNESIUM_SW_ENTRY__: JSON.stringify(`/${entry}`),
        },
        build: {
          write: false,
          minify: true,
          sourcemap: false,
          lib: {
            entry: WORKER_ENTRY,
            formats: ["iife"],
            name: "magnesiumShellWorker",
            fileName: () => "sw.js",
          },
        },
      });
      const chunk = (Array.isArray(output) ? output : [output])
        .flatMap((result) => ("output" in result ? result.output : []))
        .find((file) => file.type === "chunk");
      if (chunk === undefined)
        throw new Error("Bundling the shell service worker produced no code.");
      NodeFS.writeFileSync(NodePath.join(outDir, "sw.js"), chunk.code);
    },
  };
}
