import {
  BACKUP_NAME_PATTERN,
  UpkeepError,
  UpkeepLauncher,
  UpkeepResult,
  type BackupHealth,
  type BackupList,
  type ServerBackup,
  type UpdateInput,
  type UpkeepActivity,
  type UpkeepKind,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ServerPorts } from "../ports.ts";
import { currentRelease } from "../status/release.ts";

/**
 * A server's own upkeep (goal 35): it backs itself up every day, lists and
 * takes backups when asked, and changes build or puts a backup back through its
 * launcher. The work is `magnesium-release`'s, from this server's own release,
 * so a shell and Fleet do the same thing. Switching builds and restoring need
 * the server stopped: it leaves one line in `upkeep/pending` and stops, and its
 * launcher (`MAGNESIUM_LAUNCHER`) runs `magnesium-release apply-pending` before
 * starting it again, so nothing the server runs is cut off halfway.
 */

/** The state Fleet shows, which changes while the server runs. */
export interface UpkeepState {
  readonly backups: BackupHealth;
  readonly activity: UpkeepActivity | null;
  readonly lastResult: UpkeepResult | null;
}

export interface UpkeepConfig {
  /** `T3CODE_HOME`: its `backups/` and `upkeep/` folders, as `magnesium-release` keeps them. */
  readonly home: string;
  /** The release root, `magnesium-release`'s `MAGNESIUM_ROOT`; null when not run from a release. */
  readonly root: string | null;
  /** The release this server runs; null in development. */
  readonly release: string | null;
  /** This release's `magnesium-release`. */
  readonly script: string;
  readonly launcher: UpkeepLauncher | null;
  /** Where this server builds a release from (`MAGNESIUM_SOURCE`): a git URL or path. */
  readonly source: string | null;
  /** Stops this server for its launcher to start again. */
  readonly stop: Effect.Effect<void>;
  /** How long a release on trial runs before it counts as started fine (a minute). */
  readonly settledAfter?: Duration.Duration;
  /** `<os>-<cpu>`; the host's unless a test says otherwise. */
  readonly platform?: string;
}

/** What a test server's upkeep takes instead of its process's own (`startTestServer`). */
export const UpkeepOverrides = Context.Reference<Partial<UpkeepConfig>>(
  "@magnesium/server/upkeep/UpkeepOverrides",
  { defaultValue: () => ({}) },
);

export class Upkeep extends Context.Service<
  Upkeep,
  {
    /** The build it runs; null in development. */
    readonly release: string | null;
    /** The build a rollback goes back to; null when there is none. */
    readonly previousRelease: string | null;
    /** `<os>-<cpu>`: whether this server can run another one's build as it is. */
    readonly platform: string;
    readonly timeZone: string | null;
    readonly launcher: UpkeepLauncher | null;
    readonly state: Effect.Effect<UpkeepState>;
    readonly changes: Stream.Stream<UpkeepState>;
    readonly backups: Effect.Effect<BackupList, UpkeepError>;
    readonly backupNow: Effect.Effect<ServerBackup, UpkeepError>;
    /** Stops the server, which comes back on the backup's state. */
    readonly restore: (name: string) => Effect.Effect<void, UpkeepError>;
    /** Stops the server, which comes back on the build before. */
    readonly rollback: Effect.Effect<void, UpkeepError>;
    /** Builds the release first when asked, then stops the server, which comes back on it. */
    readonly update: (input: UpdateInput) => Effect.Effect<void, UpkeepError>;
    /** A pack of the build it runs, for a machine like it (the hub sends it); made once. */
    readonly packSelf: Effect.Effect<string, UpkeepError>;
    /** Takes a pack another server sent and unpacks it as `name`, ready to update to. */
    readonly receiveRelease: (
      name: string,
      body: Stream.Stream<Uint8Array, unknown>,
    ) => Effect.Effect<void, UpkeepError>;
  }
>()("@magnesium/server/upkeep/Upkeep") {}

/** For how many days `magnesium-release` keeps a backup a day (`MAGNESIUM_BACKUP_KEEP`). */
export const keepOf = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 7;
};

/** A backup's time from its name, `20261020T030512Z` or `20261020T030512Z-4711`. */
export const backupTimeOf = (name: string): string | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  return match === null
    ? null
    : `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
};

/** The release root from the server's own script: `<root>/releases/<name>/apps/server/…`. */
export const releaseRootOf = (scriptPath: string): string | null => {
  const index = scriptPath.search(/[\\/]releases[\\/][^\\/]+[\\/]apps[\\/]server[\\/]/);
  return index < 0 ? null : scriptPath.slice(0, index);
};

const isLauncher = Schema.is(UpkeepLauncher);
const isUpkeepError = Schema.is(UpkeepError);
export const launcherOf = (value: string | undefined): UpkeepLauncher | null => {
  const trimmed = value?.trim();
  return isLauncher(trimmed) ? trimmed : null;
};

/**
 * Why a command failed, from what it printed: `magnesium-release`'s own line,
 * else an error's first line (not a stack trace's last), else the last line.
 */
const lastLine = (text: string) => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const own = lines.findLast((line) => line.startsWith("magnesium-release: "));
  if (own !== undefined) return own.replace(/^magnesium-release: /, "");
  return lines.find((line) => /^\w*Error\b|^Error:/.test(line)) ?? lines.at(-1);
};

const ResultJson = Schema.fromJsonString(UpkeepResult);
const decodeResult = Schema.decodeUnknownOption(ResultJson);
const encodeResult = Schema.encodeSync(ResultJson);
const FailureJson = Schema.fromJsonString(
  Schema.Struct({ at: Schema.String, reason: Schema.String }),
);
const decodeFailure = Schema.decodeUnknownOption(FailureJson);
const encodeFailure = Schema.encodeSync(FailureJson);

/** A daily backup comes this long after the newest one; the first after a start waits a little. */
const BACKUP_EVERY = Duration.hours(24);
const FIRST_BACKUP_AFTER = Duration.minutes(2);
const RETRY_FAILED_BACKUP = Duration.hours(1);
/** A release on trial that has run this long has started fine. */
const SETTLED_AFTER = Duration.seconds(60);
/** Long enough for the reply that asked for it to reach the caller. */
const STOP_AFTER = Duration.millis(500);
const BUILD_TIMEOUT = Duration.hours(1);

const SETTLED_TEXT: Partial<Record<UpkeepKind, (to: string) => string>> = {
  update: (to) => `Updated to ${to}.`,
  rollback: (to) => `Rolled back to ${to}.`,
};

export const make = (config: UpkeepConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const backupsDir = path.join(config.home, "backups");
    const upkeepDir = path.join(config.home, "upkeep");
    const resultFile = path.join(upkeepDir, "result.json");
    const failureFile = path.join(upkeepDir, "backup-failure.json");
    const keep = keepOf(process.env.MAGNESIUM_BACKUP_KEEP);
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    // The script's own Node work (a live SQLite copy) runs on the Node that runs this server.
    const nodeDir = path.dirname(yield* HostProcess.ExecutablePath);
    const previousRelease =
      config.root === null
        ? null
        : yield* fs.readLink(path.join(config.root, "previous")).pipe(
            Effect.map((link) => path.basename(link)),
            Effect.orElseSucceed(() => null),
          );

    /** Runs this release's `magnesium-release`; never restarts a unit itself. */
    const runScript = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("bash", [config.script, ...args], {
            env: {
              PATH: `${nodeDir}:${process.env.PATH ?? ""}`,
              MAGNESIUM_HOME: config.home,
              ...(config.root === null ? {} : { MAGNESIUM_ROOT: config.root }),
              MAGNESIUM_RESTART: "0",
            },
            extendEnv: true,
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, code: Number(code) };
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new UpkeepError({ detail: `magnesium-release didn't run: ${String(cause)}` }),
        ),
      );

    const readFailure = fs.readFileString(failureFile).pipe(
      Effect.map((text) => Option.getOrNull(decodeFailure(text))),
      Effect.orElseSucceed(() => null),
    );
    const lastResult = yield* fs.readFileString(resultFile).pipe(
      Effect.map((text) => Option.getOrNull(decodeResult(text))),
      Effect.orElseSucceed(() => null),
    );

    const list = Effect.gen(function* () {
      const names = yield* fs
        .readDirectory(backupsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const backups: Array<ServerBackup> = [];
      for (const name of names.filter((entry) => BACKUP_NAME_PATTERN.test(entry)).toSorted()) {
        const at = backupTimeOf(name);
        if (at === null) continue;
        const folder = path.join(backupsDir, name);
        const files = yield* fs
          .readDirectory(folder, { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        let bytes = 0;
        for (const file of files) {
          const info = yield* fs.stat(path.join(folder, file)).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "File") bytes += Number(info.value.size);
        }
        backups.push({ name, at, bytes });
      }
      return backups.toReversed();
    });

    const healthOf = (backups: ReadonlyArray<ServerBackup>) =>
      Effect.gen(function* () {
        const newestAt = backups[0]?.at ?? null;
        const failure = yield* readFailure;
        return {
          newestAt,
          newestBytes: backups[0]?.bytes ?? null,
          count: backups.length,
          failure:
            failure !== null && (newestAt === null || failure.at > newestAt) ? failure : null,
        } satisfies BackupHealth;
      });

    const state = yield* SubscriptionRef.make<UpkeepState>({
      backups: yield* healthOf(yield* list),
      activity: null,
      lastResult,
    });
    const patch = (change: Partial<UpkeepState>) =>
      SubscriptionRef.update(state, (current) => ({ ...current, ...change }));
    const activity = (kind: UpkeepKind, text: string) =>
      Effect.gen(function* () {
        yield* patch({ activity: { kind, text, since: yield* now } });
      });

    const record = (result: Omit<UpkeepResult, "at">) =>
      Effect.gen(function* () {
        const full: UpkeepResult = { ...result, at: yield* now };
        yield* fs.makeDirectory(upkeepDir, { recursive: true }).pipe(Effect.ignore);
        yield* fs.writeFileString(resultFile, `${encodeResult(full)}\n`).pipe(Effect.ignore);
        yield* patch({ activity: null, lastResult: full });
      });

    const backupNow = Effect.gen(function* () {
      yield* activity("backup", "Backing up…");
      const run = yield* runScript(["backup"]).pipe(Effect.result);
      const name =
        Result.isSuccess(run) && run.success.code === 0
          ? /backups\/(\S+?)\.?$/m.exec(run.success.stdout)?.[1]
          : undefined;
      const backups = yield* list;
      const made = backups.find((backup) => backup.name === name);
      if (made === undefined) {
        const reason = Result.isFailure(run)
          ? run.failure.detail
          : (lastLine(run.success.stderr) ?? lastLine(run.success.stdout) ?? "It stopped halfway.");
        yield* fs.makeDirectory(upkeepDir, { recursive: true }).pipe(Effect.ignore);
        yield* fs
          .writeFileString(failureFile, encodeFailure({ at: yield* now, reason }))
          .pipe(Effect.ignore);
        yield* patch({ activity: null, backups: yield* healthOf(backups) });
        return yield* new UpkeepError({ detail: `The backup failed: ${reason}` });
      }
      yield* fs.remove(failureFile).pipe(Effect.ignore);
      yield* patch({ activity: null, backups: yield* healthOf(backups) });
      return made;
    }).pipe(Effect.withSpan("Upkeep.backupNow"));

    /** Leaves `line` for the launcher and stops the server, once the caller has its answer. */
    const handOver = (line: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(upkeepDir, { recursive: true });
        yield* fs.writeFileString(path.join(upkeepDir, "pending"), `${line}\n`);
        yield* Effect.forkDetach(Effect.sleep(STOP_AFTER).pipe(Effect.andThen(config.stop)));
      }).pipe(
        Effect.mapError(
          (cause) =>
            new UpkeepError({ detail: `Couldn't leave the work for the launcher: ${cause}` }),
        ),
      );

    const needsLauncher = (what: string) =>
      config.launcher === null
        ? Effect.fail(
            new UpkeepError({
              detail: `Nothing restarts this server, so it can't ${what} by itself. Use magnesium-release on it.`,
            }),
          )
        : Effect.void;

    const busy = Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current.activity !== null && current.activity.kind !== "backup") {
        return yield* new UpkeepError({ detail: `Busy: ${current.activity.text}` });
      }
    });

    const restore = (name: string) =>
      Effect.gen(function* () {
        yield* needsLauncher("restore a backup");
        yield* busy;
        const backups = yield* list;
        if (!backups.some((backup) => backup.name === name)) {
          return yield* new UpkeepError({ detail: `There is no backup named ${name}.` });
        }
        yield* activity("restore", `Restoring ${name}: stopping…`);
        yield* handOver(`restore ${name}`);
      });

    /** Releases switch only where `magnesium-release` manages them; a pod changes image instead. */
    const needsReleases = (what: string) =>
      Effect.gen(function* () {
        yield* needsLauncher(what);
        if (config.launcher !== "systemd" || config.root === null) {
          return yield* new UpkeepError({
            detail: `This server's build comes from its image, so it can't ${what} by itself.`,
          });
        }
      });

    const rollback = Effect.gen(function* () {
      yield* needsReleases("roll back");
      yield* busy;
      if (previousRelease === null) {
        return yield* new UpkeepError({ detail: "There is no build to go back to." });
      }
      yield* activity("rollback", `Rolling back to ${previousRelease}: restarting…`);
      yield* handOver(`activate ${previousRelease} rollback`);
    });

    const isBuilt = (name: string) =>
      config.root === null
        ? Effect.succeed(false)
        : fs
            .exists(path.join(config.root, "releases", name, "apps/server/dist/bin.mjs"))
            .pipe(Effect.orElseSucceed(() => false));

    const buildThenSwitch = (release: string, source: string) =>
      Effect.gen(function* () {
        const run = yield* runScript(["build", release, source]).pipe(
          Effect.timeoutOption(BUILD_TIMEOUT),
          Effect.result,
        );
        const out = Result.isSuccess(run) ? Option.getOrUndefined(run.success) : undefined;
        const built =
          out !== undefined && out.code === 0
            ? /(?:Built ([0-9a-f]{7,40})|([0-9a-f]{7,40}) is already built)/.exec(out.stdout)
            : null;
        const name = built?.[1] ?? built?.[2];
        if (name === undefined) {
          const reason = Result.isFailure(run)
            ? run.failure.detail
            : out === undefined
              ? "It took more than an hour."
              : (lastLine(out.stderr) ?? lastLine(out.stdout) ?? "It stopped halfway.");
          return yield* record({
            kind: "update",
            from: config.release,
            to: release,
            ok: false,
            detail: `The build of ${release} failed: ${reason}`,
          });
        }
        yield* activity("update", `Updating to ${name}: restarting…`);
        yield* handOver(`activate ${name} update`).pipe(
          Effect.catch((error) =>
            record({
              kind: "update",
              from: config.release,
              to: name,
              ok: false,
              detail: error.detail,
            }),
          ),
        );
      });

    const update = (input: UpdateInput) =>
      Effect.gen(function* () {
        yield* needsReleases("update");
        yield* busy;
        if (config.release !== null && input.release.startsWith(config.release)) {
          return yield* new UpkeepError({ detail: `This server is already on ${config.release}.` });
        }
        if (input.build === true) {
          if (config.source === null) {
            return yield* new UpkeepError({
              detail: "This server has no source to build from: set MAGNESIUM_SOURCE.",
            });
          }
          yield* activity("update", `Building ${input.release}…`);
          yield* Effect.forkDetach(buildThenSwitch(input.release, config.source));
          return;
        }
        if (!(yield* isBuilt(input.release))) {
          return yield* new UpkeepError({ detail: `${input.release} isn't on this server.` });
        }
        yield* activity("update", `Updating to ${input.release}: restarting…`);
        yield* handOver(`activate ${input.release} update`);
      });

    // Once a release on trial has run a while, it started fine: end the trial
    // before the launcher's next start would count against it.
    const trialFile = path.join(upkeepDir, "trial");
    if (yield* fs.exists(trialFile).pipe(Effect.orElseSucceed(() => false))) {
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep(config.settledAfter ?? SETTLED_AFTER);
          const [kind = "", , to = ""] = (yield* fs.readFileString(trialFile)).trim().split(/\s+/);
          yield* fs.remove(trialFile);
          const settled = SETTLED_TEXT[kind as UpkeepKind];
          const current = (yield* SubscriptionRef.get(state)).lastResult;
          if (settled !== undefined && current !== null && current.ok && current.to === to) {
            yield* record({ ...current, detail: settled(to) });
          }
        }).pipe(Effect.ignore),
      );
    }

    // Every day, a backup of its own; no timer or CronJob beside it.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const { backups } = yield* SubscriptionRef.get(state);
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const newest = backups.newestAt === null ? null : Date.parse(backups.newestAt);
        const failedAt = backups.failure === null ? null : Date.parse(backups.failure.at);
        const due = Math.max(
          newest === null ? 0 : newest + Duration.toMillis(BACKUP_EVERY),
          failedAt === null ? 0 : failedAt + Duration.toMillis(RETRY_FAILED_BACKUP),
          nowMillis + Duration.toMillis(FIRST_BACKUP_AFTER),
        );
        yield* Effect.sleep(Duration.millis(due - nowMillis));
        yield* backupNow.pipe(
          Effect.catch((error) => Effect.logWarning("The daily backup failed.", { error })),
        );
      }).pipe(Effect.forever),
    );

    const packSelf = Effect.gen(function* () {
      if (config.root === null || config.release === null) {
        return yield* new UpkeepError({ detail: "This server doesn't run from a release." });
      }
      const packs = path.join(config.root, "packs");
      const file = path.join(packs, `${config.release}.tar.gz`);
      if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
      yield* fs
        .makeDirectory(packs, { recursive: true })
        .pipe(Effect.mapError((cause) => new UpkeepError({ detail: `Couldn't pack: ${cause}` })));
      // Packs of older builds are of no more use: keep only this one.
      for (const old of yield* fs.readDirectory(packs).pipe(Effect.orElseSucceed(() => []))) {
        yield* fs.remove(path.join(packs, old), { recursive: true }).pipe(Effect.ignore);
      }
      const partial = `${file}.partial`;
      const run = yield* runScript(["pack", config.release, partial]);
      if (run.code !== 0) {
        return yield* new UpkeepError({
          detail: `Couldn't pack ${config.release}: ${lastLine(run.stderr) ?? "it stopped halfway"}`,
        });
      }
      yield* fs
        .rename(partial, file)
        .pipe(Effect.mapError((cause) => new UpkeepError({ detail: `Couldn't pack: ${cause}` })));
      return file;
    }).pipe(Effect.withSpan("Upkeep.packSelf"));

    const receiveRelease = (name: string, body: Stream.Stream<Uint8Array, unknown>) =>
      Effect.gen(function* () {
        yield* needsReleases("take another build");
        const root = config.root ?? "";
        const incoming = path.join(root, "incoming");
        const file = path.join(incoming, `${name}-${process.pid}.tar.gz`);
        const fail = (detail: string) => new UpkeepError({ detail });
        yield* fs
          .makeDirectory(incoming, { recursive: true })
          .pipe(Effect.mapError((cause) => fail(`Couldn't take the build: ${cause}`)));
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* Stream.run(
              body.pipe(
                Stream.mapError((cause) => fail(`The build didn't arrive whole: ${cause}`)),
              ),
              fs.sink(file),
            ).pipe(
              Effect.mapError((cause) =>
                isUpkeepError(cause) ? cause : fail(`Couldn't save the build: ${cause}`),
              ),
            );
            const run = yield* runScript(["unpack", file]);
            const unpacked = new RegExp(`(?:Unpacked ${name}\\.|${name} is already unpacked)`);
            if (run.code !== 0 || !unpacked.test(run.stdout)) {
              return yield* fail(
                `Couldn't unpack ${name}: ${lastLine(run.stderr) ?? lastLine(run.stdout) ?? "it isn't a pack of it"}`,
              );
            }
          }),
          fs.remove(file).pipe(Effect.ignore),
        );
      }).pipe(Effect.withSpan("Upkeep.receiveRelease"));

    return Upkeep.of({
      release: config.release,
      previousRelease,
      platform:
        config.platform ?? `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      launcher: config.launcher,
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      backups: list.pipe(Effect.map((backups) => ({ backups, keep }))),
      backupNow,
      restore,
      rollback,
      update,
      packSelf,
      receiveRelease,
    });
  });

/** The release's own `magnesium-release`, or the source tree's in development. */
const scriptPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const entry = process.argv[1];
  const candidates = [
    entry
      ? path.resolve(path.dirname(entry), "../../../magnesium/deploy/bin/magnesium-release")
      : "",
    yield* path
      .fromFileUrl(new URL("../../../deploy/bin/magnesium-release", import.meta.url))
      .pipe(Effect.orElseSucceed(() => "")),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
  }
  return candidates[0] ?? "magnesium-release";
});

export const layer = Layer.effect(
  Upkeep,
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const fs = yield* FileSystem.FileSystem;
    const entry = process.argv[1];
    const real =
      entry === undefined
        ? null
        : yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry));
    const overrides = yield* UpkeepOverrides;
    return yield* make({
      home: ports.baseDir,
      root: real === null ? null : releaseRootOf(real),
      release: yield* currentRelease,
      script: yield* scriptPath,
      launcher: launcherOf(process.env.MAGNESIUM_LAUNCHER),
      source: process.env.MAGNESIUM_SOURCE?.trim() || null,
      // runMain stops cleanly on SIGTERM; the launcher starts it again.
      stop: Effect.sync(() => void process.kill(process.pid, "SIGTERM")),
      ...overrides,
    });
  }),
);
