import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { MachineSetup } from "./homes.ts";
import { deploymentOf } from "../status/release.ts";

/**
 * What this server can run agents with: its name among the fleet, the real
 * CLIs, the fence, Podman, and the paths a fenced agent may read but never
 * change. Read once at start, from the environment the Ansible role (or a
 * single-box install) sets, and by probing the machine.
 */

export interface DetectedSetup {
  /** MAGNESIUM_PROFILES, else `<T3CODE_HOME>/profiles`. On a machine the hub writes it. */
  readonly folder: string;
  /** MAGNESIUM_MACHINE: the name the hub knows this server by. A hub, or a single box, is `hub`. */
  readonly machine: string;
  /** It carries machines (`hub-machines.json`): it pushes profiles and takes none. */
  readonly isHub: boolean;
  readonly setup: MachineSetup;
  /** The environment it was found from; profile sync looks on its PATH again each run. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const PROBE_TIMEOUT = Duration.seconds(10);

/**
 * Where the wrappers ship, best first: beside this package in a checkout, or
 * beside the built server in a release or pack (`<release>/apps/server/dist/bin.mjs`).
 */
export const wrapperCandidates = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fromSource = yield* path
    .fromFileUrl(new URL("../../../deploy/bin", import.meta.url))
    .pipe(Effect.orElseSucceed(() => ""));
  const entry = process.argv[1];
  const fromRelease = entry
    ? path.resolve(path.dirname(entry), "../../../magnesium/deploy/bin")
    : "";
  return [fromSource, fromRelease].filter(Boolean);
});

/** Runs a command and returns its stdout and exit code, or undefined if it could not start. */
export const runCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, [...args]));
    const [stdout, code] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout: stdout.trim(), code: Number(code) };
  }).pipe(
    Effect.scoped,
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
  );

/** The real CLI `name` as `env`'s PATH finds it (so a self-updating CLI is followed), never our wrapper. */
const lookOnPath = Effect.fn("profiles.lookOnPath")(function* (
  env: Readonly<Record<string, string | undefined>>,
  wrapperDir: string | undefined,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || (wrapperDir !== undefined && path.resolve(dir) === wrapperDir)) continue;
    const file = path.join(dir, name);
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (info._tag === "Some" && info.value.type === "File") return file;
  }
  return undefined;
});

/**
 * Where each harness's CLI is now. Profile sync asks again on every run, so a
 * CLI installed after the server started, such as one copied into a pod, counts
 * without a restart.
 */
export const findBinaries = Effect.fn("profiles.findBinaries")(function* (
  env: Readonly<Record<string, string | undefined>>,
  wrapperDir: string | undefined,
) {
  return {
    claude: env.MAGNESIUM_CLAUDE_BIN?.trim() || (yield* lookOnPath(env, wrapperDir, "claude")),
    codex: env.MAGNESIUM_CODEX_BIN?.trim() || (yield* lookOnPath(env, wrapperDir, "codex")),
    opencode: yield* lookOnPath(env, wrapperDir, "opencode"),
  };
});

export const detectSetup = Effect.fn("profiles.detectSetup")(function* (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baseDir: string;
  /** Folders that may hold the wrappers when MAGNESIUM_WRAPPER_DIR is unset, best first. */
  readonly wrapperCandidates: ReadonlyArray<string>;
  readonly serverPort?: number | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = input.env;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const stateHome = path.resolve(input.baseDir);
  const userHome = env.HOME ?? "";

  let wrapperDir: string | undefined;
  for (const dir of [env.MAGNESIUM_WRAPPER_DIR, ...input.wrapperCandidates]) {
    if (dir && (yield* exists(path.join(dir, "magnesium-wrapper")))) {
      wrapperDir = path.resolve(dir);
      break;
    }
  }
  const onPath = (name: string) => lookOnPath(env, wrapperDir, name);

  const fenceProbe =
    wrapperDir === undefined
      ? undefined
      : yield* runCommand(path.join(wrapperDir, "magnesium-fence"), ["--probe"]);
  const fence: MachineSetup["fence"] =
    wrapperDir === undefined
      ? { unavailable: "Magnesium's wrapper folder is missing." }
      : fenceProbe?.code === 0 && fenceProbe.stdout
        ? { mechanism: fenceProbe.stdout }
        : {
            unavailable:
              fenceProbe?.stdout.replace(/^none: /, "") || "The fence probe did not run.",
          };

  const deployment = deploymentOf(env.MAGNESIUM_DEPLOY);
  const image = env.MAGNESIUM_SANDBOX_IMAGE?.trim() || undefined;
  const inPod = deployment === "pod" || deployment === "attached";
  const podman = inPod ? undefined : yield* onPath("podman");
  const podmanWorks =
    podman === undefined
      ? false
      : (yield* runCommand(podman, ["info", "--format", "{{.Host.Security.Rootless}}"]))?.code ===
        0;
  const container: MachineSetup["container"] = inPod
    ? { unavailable: "Agents can't start containers inside a pod." }
    : podman === undefined
      ? { unavailable: "Podman is not installed." }
      : !podmanWorks
        ? { unavailable: "Podman does not run for this user." }
        : image === undefined
          ? { unavailable: "No image is set (MAGNESIUM_SANDBOX_IMAGE)." }
          : { image };

  // What a fenced agent may read but never change: the installed server (not a
  // checkout, where agents work on the code), its unit and its env file.
  const protect: string[] = [];
  if (wrapperDir !== undefined) {
    const real = yield* fs.realPath(wrapperDir).pipe(Effect.orElseSucceed(() => wrapperDir!));
    const releases = real.indexOf(`${path.sep}releases${path.sep}`);
    if (releases > 0) protect.push(real.slice(0, releases));
  }
  if (userHome) {
    protect.push(
      path.join(userHome, ".config", "magnesium"),
      path.join(userHome, ".config", "systemd", "user"),
    );
  }
  for (const extra of (env.MAGNESIUM_FENCE_PROTECT ?? "").split(":"))
    if (extra) protect.push(extra);

  return {
    folder: path.resolve(env.MAGNESIUM_PROFILES?.trim() || path.join(stateHome, "profiles")),
    machine: env.MAGNESIUM_MACHINE?.trim() || "hub",
    env,
    isHub: yield* exists(path.join(stateHome, "hub-machines.json")),
    setup: {
      stateHome,
      wrapperDir,
      binaries: yield* findBinaries(env, wrapperDir),
      userHome,
      fence,
      container,
      deployment,
      runsAgents: env.MAGNESIUM_ROLE?.trim() !== "gateway",
      protect,
      serverPort: input.serverPort,
    },
  } satisfies DetectedSetup;
});
