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
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { Fleet } from "../fleet/Fleet.ts";
import { HubMachines } from "../hub/HubMachines.ts";
import { connectMachine } from "../hub/machineRpc.ts";
import { loadCatalog, ProfilesConfig } from "./catalog.ts";
import { FILES } from "./profileFolder.ts";

/**
 * The hub holds the owner's profiles and pushes each to the machines it names
 * (D39), over its link to each machine's `/api/magnesium/ws`, with the token it
 * already holds. The machines never dial the hub (D35). Each tick the hub works
 * out every machine's revision from its own folder, and asks a machine which
 * revision it holds only when there is a reason: that revision changed, the
 * machine's server restarted (Fleet sees a new start), the last ask failed, or
 * RECHECK_EVERY passed. It pushes only when the answer differs. So a new or
 * edited profile reaches its machines within PUSH_EVERY, a wiped machine is
 * filled again when it comes back, and a quiet fleet costs one call per
 * machine every RECHECK_EVERY. Send now (`sendNow`) asks every connected
 * machine regardless, for when one lost its profiles and nothing says so.
 *
 * The push needs `orchestration:operate` on the machine: the scope that already
 * edits provider instances through `server.updateSettings`, which is what a
 * profile becomes. It never needs `access:write`; the hub holds no admin token.
 * Each machine checks every profile itself before taking it.
 */

const PUSH_EVERY = Duration.seconds(20);
/** In case a machine's profiles went missing while its server kept running. */
const RECHECK_EVERY = Duration.minutes(10);
const CALL_TIMEOUT = Duration.seconds(20);
const NOT_CONNECTED = "The hub isn't connected to this machine.";

/** What a machine was last found to hold, under which start of its server, and when. */
export interface HeldRevision {
  readonly revision: string;
  readonly startedAt: string | null;
  readonly checkedAt: number;
}

/** Whether to ask a connected machine for its revision now (see above). */
export const askDue = (
  held: HeldRevision | undefined,
  machine: { readonly revision: string; readonly startedAt: string | null },
  now: number,
) =>
  held === undefined ||
  held.revision !== machine.revision ||
  held.startedAt !== machine.startedAt ||
  now - held.checkedAt >= Duration.toMillis(RECHECK_EVERY);

export class HubProfilePusher extends Context.Service<
  HubProfilePusher,
  {
    /** One tick: asks a machine only when there is a reason (see above). */
    readonly pushNow: Effect.Effect<void>;
    /** Asks every connected machine now, and pushes to each that holds another revision. */
    readonly sendNow: Effect.Effect<void>;
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
      contentBase64: Base64.encode(content),
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
  return Hex.encode(digest).slice(0, 16);
});

export const make = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  const fleet = yield* Fleet;
  const context = yield* Effect.context<
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | HubMachines | HttpClient.HttpClient
  >();
  const statuses = yield* Ref.make(new Map<string, Omit<ProfilePushStatus, "current">>());
  const held = new Map<string, HeldRevision>();
  /** What each machine should hold, as of the last tick. */
  const wanted = new Map<string, string>();

  const setStatus = (status: Omit<ProfilePushStatus, "current">) =>
    Ref.update(statuses, (current) => new Map(current).set(status.machine, status));

  /** Pushes `profiles` to one machine if it holds another revision; returns what it refused. */
  const pushTo = (name: string, push: ProfilePush) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connectMachine(name);
        const holding = yield* client[MAGNESIUM_WS_METHODS.profileRevision]({});
        if (holding.revision === push.revision) return undefined;
        return yield* client[MAGNESIUM_WS_METHODS.pushProfiles](push);
      }),
    ).pipe(Effect.timeout(CALL_TIMEOUT));

  const pushOnce = Effect.fnUntraced(function* (askEvery: boolean) {
    const machines = yield* fleet.machines;
    if (machines.length === 0) return;
    const path = yield* Path.Path;
    const entries = yield* loadCatalog(config.folder);
    for (const entry of entries.filter((candidate) => !candidate.ready)) {
      yield* Effect.logWarning("A profile on the hub has errors; its machines will refuse it.", {
        profile: entry.profile.name,
        issues: entry.issues.filter((issue) => issue.level === "error").map((i) => i.message),
      });
    }
    const bundles = new Map<string, ProfileBundle>();
    for (const machine of machines) {
      const name = machine.name;
      if (name === null) continue;
      const nowAt = yield* DateTime.now;
      const now = DateTime.formatIso(nowAt);
      const profiles: ProfileBundle[] = [];
      for (const entry of entries) {
        const { machines: names } = entry.resolved;
        if (!names.includes(name) && !names.includes("*")) continue;
        const bundle =
          bundles.get(entry.profile.name) ??
          (yield* bundleProfile(path.join(config.folder, entry.profile.name), entry.profile.name));
        bundles.set(entry.profile.name, bundle);
        profiles.push(bundle);
      }
      const revision = yield* revisionOf(profiles);
      wanted.set(name, revision);
      if (machine.link === "no-access") {
        held.delete(name);
        yield* setStatus({
          machine: name,
          revision: null,
          checkedAt: now,
          error: "The hub has no access to this machine.",
          refused: [],
        });
        continue;
      }
      const previous = (yield* Ref.get(statuses)).get(name);
      // Offline or still connecting: its row says so, keeping what it last held, and it is
      // asked once its link is up.
      if (machine.link !== "connected") {
        yield* setStatus({
          machine: name,
          revision: previous?.revision ?? null,
          checkedAt: previous?.checkedAt ?? null,
          error: NOT_CONNECTED,
          refused: previous?.refused ?? [],
        });
        continue;
      }
      const checkedAt = DateTime.toEpochMillis(nowAt);
      if (
        !askEvery &&
        !askDue(held.get(name), { revision, startedAt: machine.startedAt }, checkedAt)
      ) {
        // Back on the same start of its server: it still holds what it held.
        if (previous?.error === NOT_CONNECTED) yield* setStatus({ ...previous, error: null });
        continue;
      }
      const outcome = yield* pushTo(name, { revision, profiles }).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        held.delete(name);
        yield* setStatus({
          machine: name,
          revision: null,
          checkedAt: now,
          error: `Could not push: ${String(outcome.failure)}`,
          refused: [],
        });
        continue;
      }
      held.set(name, { revision, startedAt: machine.startedAt, checkedAt });
      const result = outcome.success;
      if (result !== undefined) {
        yield* Effect.logInfo("Pushed profiles to a machine.", {
          machine: name,
          revision,
          accepted: result.accepted,
          refused: result.refused.map((profile) => profile.name),
          removed: result.removed,
        });
      }
      yield* setStatus({
        machine: name,
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

  const push = (askEvery: boolean) =>
    pushOnce(askEvery).pipe(
      Effect.provideContext(context),
      Effect.catch((error) => Effect.logError("Profile push failed.", { error: String(error) })),
      Effect.withSpan(askEvery ? "HubProfilePusher.sendNow" : "HubProfilePusher.pushNow"),
    );
  const status = Ref.get(statuses).pipe(
    Effect.map((current) =>
      [...current.values()].map((entry) => ({
        ...entry,
        current: entry.revision !== null && entry.revision === wanted.get(entry.machine),
      })),
    ),
  );
  return HubProfilePusher.of({ pushNow: push(false), sendNow: push(true), status });
});

export const layer = Layer.effect(HubProfilePusher, make);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const pusher = yield* HubProfilePusher;
    yield* pusher.pushNow.pipe(Effect.repeat(Schedule.spaced(PUSH_EVERY)), Effect.forkScoped);
  }),
);
