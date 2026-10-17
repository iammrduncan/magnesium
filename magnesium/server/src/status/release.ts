import { ServerDeployment } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/**
 * The release a server runs. `magnesium-release` keeps each build in
 * `<root>/releases/<name>/` and points `current` at one, so the server's own
 * script, with links followed, names it. Null in development, where nothing
 * runs from a release.
 */

const RELEASE_IN_PATH = /[\\/]releases[\\/]([^\\/]+)[\\/]apps[\\/]server[\\/]/;

export const releaseOf = (scriptPath: string): string | null =>
  RELEASE_IN_PATH.exec(scriptPath)?.[1] ?? null;

export const currentRelease = Effect.gen(function* () {
  const script = globalThis.process?.argv?.[1];
  if (script === undefined || script.length === 0) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = yield* fileSystem.realPath(script).pipe(Effect.orElseSucceed(() => script));
  return releaseOf(real);
});

const isDeployment = Schema.is(ServerDeployment);

/**
 * How this server is deployed, from `MAGNESIUM_DEPLOY`: the image sets `pod`,
 * the Ansible role `bare-metal` or `vm`. Anything else is unknown.
 */
export const deploymentOf = (value: string | undefined): ServerDeployment | null => {
  const trimmed = value?.trim();
  return isDeployment(trimmed) ? trimmed : null;
};

/** Where this server runs, from `MAGNESIUM_NODE`: a pod's node, or what its deployer says. */
export const nodeOf = (value: string | undefined): string | null => value?.trim() || null;

/** `gateway` when `MAGNESIUM_ROLE` says so (goal 25). */
export const roleOf = (value: string | undefined): "gateway" | null =>
  value?.trim() === "gateway" ? "gateway" : null;
