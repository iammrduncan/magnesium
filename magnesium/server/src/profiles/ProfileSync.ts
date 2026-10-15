import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerPorts } from "../ports.ts";
import { isPushManaged, loadCatalog, ProfilesConfig, runsHere } from "./catalog.ts";
import { type PlannedInstance, planProfile, writeHomes } from "./homes.ts";
import { runCommand } from "./setup.ts";
import { desiredInstances } from "./stock.ts";

/**
 * Profile sync, on every server: the hub, each machine, a single box. It reads
 * the local profiles folder, writes the homes of each ready profile that runs
 * here, fences the stock provider instances, and keeps settings.json's provider
 * instances to match. Settings hot-reload, so a profile the hub pushes appears
 * without a restart. Refused profiles get no instance; the others keep working.
 */

/** A profile the hub pushes syncs at once; this catches edits made by hand. */
const SYNC_EVERY = Duration.seconds(15);

export interface SyncReport {
  readonly profiles: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<string>;
  readonly changed: boolean;
}

export class ProfileSync extends Context.Service<
  ProfileSync,
  { readonly syncNow: Effect.Effect<SyncReport> }
>()("@magnesium/server/profiles/ProfileSync") {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Key order must not count as a change. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value;
const fingerprint = (value: unknown) => encodeJson(canonical(value));

export const make = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  const ports = yield* ServerPorts;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | ProfilesConfig>();
  const lock = yield* Semaphore.make(1);

  const syncOnce = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* loadCatalog(config.folder);
    const pushManaged = yield* isPushManaged(config.folder);
    const planned: PlannedInstance[] = [];
    const profiles: string[] = [];
    const refused: string[] = [];
    for (const entry of entries) {
      if (!runsHere(entry.resolved, config.machine, pushManaged)) continue;
      if (!entry.ready) {
        refused.push(entry.profile.name);
        yield* Effect.logWarning("Profile refused; it gets no provider instance.", {
          profile: entry.profile.name,
          issues: entry.issues.filter((issue) => issue.level === "error").map((i) => i.message),
        });
        continue;
      }
      const plan = planProfile(path, entry.resolved, config.setup);
      if (plan.instances.length === 0) continue;
      const written = yield* writeHomes(entry.resolved, config.setup).pipe(Effect.result);
      if (written._tag === "Failure") {
        refused.push(entry.profile.name);
        yield* Effect.logError("Could not write a profile's homes.", {
          profile: entry.profile.name,
          error: written.failure.message,
        });
        continue;
      }
      profiles.push(entry.profile.name);
      planned.push(...plan.instances);
    }

    const settings = yield* ports.getSettings;
    const known = new Set(
      Object.values(config.setup.binaries).filter((binary) => binary !== undefined),
    );
    // A bare command is installed when the PATH has it; a path when it exists.
    const absolute = new Set<string>();
    for (const instance of Object.values(settings.providerInstances)) {
      const binary = (instance.config as { readonly binaryPath?: unknown } | undefined)?.binaryPath;
      if (typeof binary === "string" && binary.startsWith("/")) {
        if (yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false))) absolute.add(binary);
      }
    }
    const installed = (binary: string) =>
      binary.includes("/")
        ? absolute.has(binary) || known.has(binary)
        : [...known].some((found) => path.basename(found) === binary);
    const next = desiredInstances({
      path,
      settings,
      setup: config.setup,
      profiles: planned,
      installed,
    });
    if (fingerprint(next) === fingerprint(settings.providerInstances)) {
      return { profiles, refused, changed: false } satisfies SyncReport;
    }
    yield* ports.setProviderInstances(next as ProviderInstanceConfigMap);
    yield* Effect.logInfo("Profile sync updated the provider instances.", {
      profiles,
      refused,
      instances: Object.keys(next),
    });
    return { profiles, refused, changed: true } satisfies SyncReport;
  });

  const syncNow = lock
    .withPermits(1)(syncOnce)
    .pipe(
      Effect.provideContext(context),
      Effect.catch((error) =>
        Effect.logError("Profile sync failed.", { error: error.message }).pipe(
          Effect.as({ profiles: [], refused: [], changed: false } satisfies SyncReport),
        ),
      ),
      Effect.withSpan("ProfileSync.syncNow"),
    );
  return ProfileSync.of({ syncNow });
});

export const layer = Layer.effect(ProfileSync, make);

/**
 * Containers this server's wrappers started and a restart left behind. No turn
 * survives a restart (doc 11, Status), so every one with our state label is stale.
 */
const clearStaleContainers = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  if (!("image" in config.setup.container)) return;
  const listed = yield* runCommand("podman", [
    "ps",
    "-aq",
    "--filter",
    `label=io.magnesium.state=${config.setup.stateHome}`,
  ]);
  const ids = (listed?.stdout ?? "")
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  yield* runCommand("podman", ["rm", "-f", "-t", "0", ...ids]);
  yield* Effect.logInfo("Removed agent containers left by the last run.", { count: ids.length });
});

/** Sync at start, then every SYNC_EVERY. */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* ProfileSync;
    yield* clearStaleContainers.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        yield* ChildProcessSpawner.ChildProcessSpawner,
      ),
    );
    yield* sync.syncNow.pipe(Effect.repeat(Schedule.spaced(SYNC_EVERY)), Effect.forkScoped);
  }),
);
