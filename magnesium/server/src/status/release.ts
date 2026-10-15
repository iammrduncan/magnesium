import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

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
