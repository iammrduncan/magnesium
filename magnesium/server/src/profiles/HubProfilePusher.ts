import {
  MAGNESIUM_WS_METHODS,
  type ProfileBundle,
  type ProfileFile,
  ProfilePush,
  type ProfilePushStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { HubMachines } from "../hub/HubMachines.ts";
import { connectMachine } from "../hub/machineRpc.ts";
import { loadCatalog, ProfilesConfig } from "./catalog.ts";
import { FILES } from "./profileFolder.ts";

/**
 * The hub holds the owner's profiles and pushes each to the machines it names
 * (D39), over its link to each machine's `/api/magnesium/ws`, with the token it
 * already holds. The machines never dial the hub (D35). Each tick the hub asks
 * every machine which revision it holds and pushes only when that differs, so a
 * new or edited profile reaches its machines within PUSH_EVERY, and a wiped
 * machine is filled again.
 *
 * The push needs `orchestration:operate` on the machine: the scope that already
 * edits provider instances through `server.updateSettings`, which is what a
 * profile becomes. It never needs `access:write`; the hub holds no admin token.
 * Each machine checks every profile itself before taking it.
 */

const PUSH_EVERY = Duration.seconds(20);
const CALL_TIMEOUT = Duration.seconds(20);

export class HubProfilePusher extends Context.Service<
  HubProfilePusher,
  {
    readonly pushNow: Effect.Effect<void>;
    readonly status: Effect.Effect<ReadonlyArray<ProfilePushStatus>>;
  }
>()("@magnesium/server/profiles/HubProfilePusher") {}

/** Every file of a profile folder except dot-entries (`.magnesium/`, `.git`), sorted. */
export const bundleProfile = Effect.fn("profiles.bundleProfile")(function* (
  dir: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: ProfileFile[] = [];
  const entries = yield* fs.readDirectory(dir, { recursive: true });
  for (const entry of entries.toSorted()) {
    const segments = entry.split(path.sep);
    if (segments.some((segment) => segment.startsWith("."))) continue;
    const info = yield* fs.stat(path.join(dir, entry));
    if (info.type !== "File") continue;
    const content = yield* fs.readFile(path.join(dir, entry));
    files.push({
      path: segments.join("/"),
      contentBase64: Encoding.encodeBase64(content),
      ...(segments[0] === FILES.skills && (info.mode & 0o111) !== 0 ? { executable: true } : {}),
    });
  }
  return { name, files } satisfies ProfileBundle;
});

const encodePush = Schema.encodeSync(Schema.fromJsonString(ProfilePush));

export const revisionOf = Effect.fn("profiles.revisionOf")(function* (
  profiles: ReadonlyArray<ProfileBundle>,
) {
  const crypto = yield* Crypto.Crypto;
  const bytes = new TextEncoder().encode(encodePush({ revision: "", profiles }));
  const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie);
  return Encoding.encodeHex(digest).slice(0, 16);
});

export const make = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  const machines = yield* HubMachines;
  const context = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | HubMachines | HttpClient.HttpClient
  >();
  const statuses = yield* Ref.make(new Map<string, ProfilePushStatus>());

  const setStatus = (status: ProfilePushStatus) =>
    Ref.update(statuses, (current) => new Map(current).set(status.machine, status));

  /** Pushes `profiles` to one machine if it holds another revision; returns what it refused. */
  const pushTo = (name: string, push: ProfilePush) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connectMachine(name);
        const held = yield* client[MAGNESIUM_WS_METHODS.profileRevision]({});
        if (held.revision === push.revision) return undefined;
        return yield* client[MAGNESIUM_WS_METHODS.pushProfiles](push);
      }),
    ).pipe(Effect.timeout(CALL_TIMEOUT));

  const pushOnce = Effect.gen(function* () {
    const list = yield* machines.list;
    if (list.machines.length === 0) return;
    const path = yield* Path.Path;
    const entries = yield* loadCatalog(config.folder);
    for (const entry of entries.filter((candidate) => !candidate.ready)) {
      yield* Effect.logWarning("A profile on the hub has errors; its machines will refuse it.", {
        profile: entry.profile.name,
        issues: entry.issues.filter((issue) => issue.level === "error").map((i) => i.message),
      });
    }
    const bundles = new Map<string, ProfileBundle>();
    for (const machine of list.machines) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const profiles: ProfileBundle[] = [];
      for (const entry of entries) {
        const { machines: names } = entry.resolved;
        if (!names.includes(machine.name) && !names.includes("*")) continue;
        const bundle =
          bundles.get(entry.profile.name) ??
          (yield* bundleProfile(path.join(config.folder, entry.profile.name), entry.profile.name));
        bundles.set(entry.profile.name, bundle);
        profiles.push(bundle);
      }
      const revision = yield* revisionOf(profiles);
      if (machine.access !== "ready") {
        yield* setStatus({
          machine: machine.name,
          revision: null,
          checkedAt: now,
          error: "The hub has no access to this machine.",
          refused: [],
        });
        continue;
      }
      const outcome = yield* pushTo(machine.name, { revision, profiles }).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        yield* setStatus({
          machine: machine.name,
          revision: null,
          checkedAt: now,
          error: `Could not push: ${String(outcome.failure)}`,
          refused: [],
        });
        continue;
      }
      const result = outcome.success;
      if (result !== undefined) {
        yield* Effect.logInfo("Pushed profiles to a machine.", {
          machine: machine.name,
          revision,
          accepted: result.accepted,
          refused: result.refused.map((profile) => profile.name),
          removed: result.removed,
        });
      }
      const previous = (yield* Ref.get(statuses)).get(machine.name);
      yield* setStatus({
        machine: machine.name,
        revision,
        checkedAt: now,
        error: null,
        refused:
          result === undefined
            ? (previous?.refused ?? [])
            : result.refused.map((profile) => profile.name),
      });
    }
  });

  const pushNow = pushOnce.pipe(
    Effect.provideContext(context),
    Effect.catch((error) => Effect.logError("Profile push failed.", { error: String(error) })),
    Effect.withSpan("HubProfilePusher.pushNow"),
  );
  const status = Ref.get(statuses).pipe(Effect.map((current) => [...current.values()]));
  return HubProfilePusher.of({ pushNow, status });
});

export const layer = Layer.effect(HubProfilePusher, make);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const pusher = yield* HubProfilePusher;
    yield* pusher.pushNow.pipe(Effect.repeat(Schedule.spaced(PUSH_EVERY)), Effect.forkScoped);
  }),
);
