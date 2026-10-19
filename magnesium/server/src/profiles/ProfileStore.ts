import {
  type DeletedProfile,
  MAGNESIUM_MCP_SERVER,
  PROFILE_NAME_PATTERN,
  PROFILE_TRASH_DAYS,
  type ProfileBundle,
  type ProfileChange,
  type ProfileCreateInput,
  type ProfileDelivery,
  type ProfileDetail,
  ProfileError,
  type ProfileHarness,
  type ProfileMcpServer,
  type ProfilePushStatus,
  type ProfilePutBackInput,
  type ProfileSaveResult,
  type ProfileSettingsChange,
  type ProfileSkill,
  type ProfileTextFile,
  type ProfileVersion,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { isMap, parseDocument } from "yaml";

import { HubMachines } from "../hub/HubMachines.ts";
import { InstanceSource, isPushManaged, ProfilesConfig, summarize } from "./catalog.ts";
import { bundleProfile, HubProfilePusher, revisionOf } from "./HubProfilePusher.ts";
import {
  checkProfile,
  DEFAULT_TOOL_PERMISSION,
  decodeMcpFile,
  EXTRA_INSTRUCTIONS,
  FILES,
  hasErrors,
  launchArgList,
  loadProfile,
  type ProfileMeta,
  readOptional,
  resolveProfile,
} from "./profileFolder.ts";
import { ProfileSync } from "./ProfileSync.ts";
import { profileTemplate } from "./template.ts";

/**
 * The owner's profiles, changed from the app (goal 34, D65, D67). The hub, or a
 * single box, keeps each profile as a folder; this reads it whole and changes it
 * a file or a setting at a time. A change is checked on a copy first and written
 * only when it passes, so a refused change leaves the profile, and every machine
 * running it, as they were. Each change is kept as a version under `.history/`,
 * which Put back restores, and a deleted profile waits in `.trash/` for
 * PROFILE_TRASH_DAYS. A machine's folder is the hub's to fill: it can't change.
 */
export class ProfileStore extends Context.Service<
  ProfileStore,
  {
    readonly detail: (name: string) => Effect.Effect<ProfileDetail, ProfileError>;
    /** `by` names who changed it, for its history: "You", or an agent you approved. */
    readonly save: (
      change: ProfileChange,
      by: string,
    ) => Effect.Effect<ProfileSaveResult, ProfileError>;
    readonly create: (
      input: ProfileCreateInput,
      by: string,
    ) => Effect.Effect<ProfileSaveResult, ProfileError>;
    readonly remove: (name: string, by: string) => Effect.Effect<void, ProfileError>;
    readonly deleted: Effect.Effect<ReadonlyArray<DeletedProfile>, ProfileError>;
    readonly restore: (name: string, by: string) => Effect.Effect<void, ProfileError>;
    readonly putBack: (
      input: ProfilePutBackInput,
      by: string,
    ) => Effect.Effect<ProfileSaveResult, ProfileError>;
    /** Ask the hub to deliver to its machines now rather than on its next tick. */
    readonly sendNow: Effect.Effect<void>;
  }
>()("@magnesium/server/profiles/ProfileStore") {}

const HISTORY_DIR = ".history";
const TRASH_DIR = ".trash";
/** A profile's files are text, and small. */
const MAX_FILE_BYTES = 256 * 1024;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_HISTORY_SHOWN = 50;

/** Magnesium's own tools ask nothing by default: every change they make waits for you anyway. */
const OWN_SERVER_DEFAULTS = { default: "allow", tools: {} } as const;

const Snapshot = Schema.Struct({
  version: Schema.Number,
  at: Schema.String,
  by: Schema.String,
  summary: Schema.String,
  hash: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      contentBase64: Schema.String,
      executable: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type Snapshot = typeof Snapshot.Type;
const SnapshotJson = Schema.fromJsonString(Snapshot);
const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);

const fail = (detail: string) => Effect.fail(new ProfileError({ detail }));
const isProfileError = Schema.is(ProfileError);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Why a path can't be written from the app, or undefined when it can. */
export const pathProblem = (path: string): string | undefined => {
  const segments = path.split("/");
  if (
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment.startsWith("."))
  ) {
    return `${path} isn't a path inside the profile.`;
  }
  if (path === FILES.meta) return `${FILES.meta} changes through the profile's settings.`;
  if (segments.length === 1) {
    return path === FILES.mcp || path === FILES.hooks || EXTRA_INSTRUCTIONS.test(path)
      ? undefined
      : `${path}: a profile's own files are Markdown, ${FILES.mcp} and ${FILES.hooks}.`;
  }
  if (segments[0] === FILES.skills && segments.length >= 3 && SKILL_NAME.test(segments[1]!)) {
    return undefined;
  }
  return `${path}: files in folders belong in ${FILES.skills}/<skill>/.`;
};

/** profile.yaml with `settings` applied, its comments and order kept. */
export const applySettings = (text: string, settings: ProfileSettingsChange): string => {
  const doc = parseDocument(text);
  const set = (key: string, value: unknown) => doc.set(key, doc.createNode(value, { flow: true }));
  if (settings.displayName !== undefined) {
    if (settings.displayName === null || settings.displayName.trim() === "")
      doc.delete("display_name");
    else doc.set("display_name", settings.displayName);
  }
  if (settings.description !== undefined) doc.set("description", settings.description);
  if (settings.accentColor !== undefined) {
    if (settings.accentColor === null) doc.delete("accent");
    else doc.set("accent", settings.accentColor);
  }
  if (settings.harnesses !== undefined && settings.harnesses.length > 0) {
    doc.set("harness", settings.harnesses[0]);
    if (settings.harnesses.length > 1) set("harnesses", settings.harnesses);
    else doc.delete("harnesses");
  }
  if (settings.sandbox !== undefined) doc.setIn(["sandbox", "level"], settings.sandbox);
  if (settings.machines !== undefined) set("machines", settings.machines);
  if (settings.env !== undefined) set("env", settings.env);
  if (settings.launchArgs !== undefined) {
    if (settings.launchArgs.length === 0) doc.delete("launch_args");
    else set("launch_args", settings.launchArgs);
  }
  if (settings.toolPermissions !== undefined) {
    for (const [server, value] of Object.entries(settings.toolPermissions)) {
      if (value === null) doc.deleteIn(["tool_permissions", server]);
      else doc.setIn(["tool_permissions", server], doc.createNode(value));
    }
    const remaining = doc.get("tool_permissions");
    if (isMap(remaining) && remaining.items.length === 0) doc.delete("tool_permissions");
  }
  return doc.toString();
};

/** One line saying what a change does, for its history, when its author gave none. */
const describeChange = (change: ProfileChange): string => {
  const parts: string[] = [];
  for (const file of change.files ?? []) {
    parts.push(file.content === null ? `removed ${file.path}` : `${file.path}`);
  }
  const settings = change.settings ?? {};
  const named: Record<string, string> = {
    displayName: "display name",
    description: "description",
    accentColor: "accent",
    harnesses: "harnesses",
    sandbox: "default sandbox",
    machines: "machines",
    env: "environment",
    launchArgs: "launch arguments",
    toolPermissions: "tool permissions",
  };
  for (const key of Object.keys(settings)) parts.push(named[key] ?? key);
  return parts.length === 0 ? "No change" : `Changed ${parts.join(", ")}`;
};

/** The `${NAME}` variables a server's configuration reads. */
const secretsOf = (server: unknown): string[] => {
  const text = JSON.stringify(server ?? {});
  return [
    ...new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!)),
  ];
};

const howOf = (server: unknown): string => {
  if (!Predicate.isObject(server)) return "";
  const record = server as Record<string, unknown>;
  if (typeof record.url === "string") return record.url;
  if (typeof record.command === "string") {
    const args = Array.isArray(record.args) ? record.args.filter(Predicate.isString) : [];
    return `command: ${[record.command, ...args].join(" ")}`;
  }
  return "";
};

/** SKILL.md's `description:`, or its first line of prose. */
const skillDescription = (text: string | undefined): string => {
  if (text === undefined) return "No SKILL.md.";
  const field = /^description:\s*(.+)$/m.exec(text);
  if (field) return field[1]!.trim().replace(/^["']|["']$/g, "");
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) => line !== "" && line !== "---" && !line.startsWith("#") && !line.includes(":"),
      ) ?? ""
  );
};

export const make = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  const instances = yield* InstanceSource;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sync = yield* Effect.serviceOption(ProfileSync);
  const pusher = yield* Effect.serviceOption(HubProfilePusher);
  const machines = yield* Effect.serviceOption(HubMachines);
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const root = config.folder;

  const withServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const io = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
  ) =>
    withServices(effect).pipe(
      Effect.mapError((error) =>
        isProfileError(error) ? error : new ProfileError({ detail: String(error) }),
      ),
    );

  const dirOf = (name: string) => path.join(root, name);
  const historyOf = (name: string) => path.join(root, HISTORY_DIR, name);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  const requireEditable = Effect.gen(function* () {
    if (yield* withServices(isPushManaged(root))) {
      return yield* fail("This machine's profiles come from the hub: change them there.");
    }
  });

  const requireProfile = (name: string) =>
    Effect.gen(function* () {
      if (
        !PROFILE_NAME_PATTERN.test(name) ||
        !(yield* exists(path.join(dirOf(name), FILES.meta)))
      ) {
        return yield* fail(`There's no profile named ${name}.`);
      }
    });

  // History: one JSON file per version, holding the whole folder as it was.
  const snapshots = (name: string) =>
    Effect.gen(function* () {
      const dir = historyOf(name);
      const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
      const found: Snapshot[] = [];
      for (const entry of entries.filter((file) => file.endsWith(".json"))) {
        const text = yield* readOptional(path.join(dir, entry));
        const decoded =
          text === undefined ? Option.none() : yield* decodeSnapshot(text).pipe(Effect.option);
        if (Option.isSome(decoded)) found.push(decoded.value);
      }
      return found.toSorted((a, b) => a.version - b.version);
    });

  const bundleOf = (name: string) => withServices(bundleProfile(dirOf(name), name));

  /** Keeps the folder as it is now as the next version, unless the last one already is. */
  const record = (name: string, by: string, summary: string) =>
    Effect.gen(function* () {
      const bundle = yield* bundleOf(name);
      const hash = yield* withServices(revisionOf([bundle]));
      const all = yield* snapshots(name);
      const last = all.at(-1);
      if (last !== undefined && last.hash === hash) return last.version;
      const version = (last?.version ?? 0) + 1;
      const snapshot: Snapshot = {
        version,
        at: yield* now,
        by,
        summary,
        hash,
        files: bundle.files,
      };
      yield* fs.makeDirectory(historyOf(name), { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(
        path.join(historyOf(name), `${String(version).padStart(5, "0")}.json`),
        yield* encodeSnapshot(snapshot).pipe(Effect.orDie),
      );
      return version;
    });

  /** A change made outside the app (by hand, or by the CLI) becomes a version when it is next read. */
  const catchUp = (name: string) =>
    snapshots(name).pipe(
      Effect.flatMap((all) =>
        record(name, "On disk", all.length === 0 ? "Found on disk" : "Changed outside the app"),
      ),
    );

  /** The machines that run local profiles here, and the hub's, after a change. */
  const deliver = Effect.gen(function* () {
    if (Option.isSome(sync)) yield* sync.value.syncNow.pipe(Effect.ignore);
    if (Option.isSome(pusher)) yield* Effect.forkIn(pusher.value.pushNow, scope);
  });

  /** Writes `bundle` as `name`'s folder under `dir`, replacing what was there. */
  const writeBundle = (dir: string, bundle: ProfileBundle) =>
    Effect.gen(function* () {
      for (const file of bundle.files) {
        const target = path.join(dir, ...file.path.split("/"));
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        const bytes = Base64.decode(file.contentBase64);
        if (bytes._tag === "Failure") return yield* fail(`${file.path} couldn't be read back.`);
        yield* fs.writeFile(target, bytes.success);
        if (file.executable) yield* fs.chmod(target, 0o755);
      }
    });

  const applyFiles = (dir: string, files: NonNullable<ProfileChange["files"]>) =>
    Effect.gen(function* () {
      for (const file of files) {
        const target = path.join(dir, ...file.path.split("/"));
        if (file.content === null) {
          yield* fs.remove(target, { force: true });
          // An emptied skill folder goes with its last file.
          const parent = path.dirname(target);
          if (
            parent !== dir &&
            (yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => ["x"]))).length === 0
          ) {
            yield* fs.remove(parent, { recursive: true, force: true });
          }
        } else {
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, file.content);
        }
      }
    });

  /** What the check says of the profile as `apply` would leave it, worked out on a copy. */
  const checkCopy = (
    name: string,
    apply: (
      dir: string,
    ) => Effect.Effect<
      void,
      ProfileError | PlatformError,
      FileSystem.FileSystem | Path.Path | Crypto.Crypto
    >,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "mg-profile-" });
        const dir = path.join(temp, name);
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* writeBundle(dir, yield* bundleOf(name));
        yield* withServices(apply(dir));
        return yield* withServices(checkProfile(yield* withServices(loadProfile(temp, name))));
      }),
    );

  const validateChange = (change: ProfileChange) =>
    Effect.gen(function* () {
      for (const file of change.files ?? []) {
        const problem = pathProblem(file.path);
        if (problem !== undefined) return yield* fail(problem);
        if (file.content === null && file.path === FILES.agents) {
          return yield* fail(
            `${FILES.agents} holds the agent's role and rules: it can't be removed.`,
          );
        }
        if (file.content !== null && encoder.encode(file.content).length > MAX_FILE_BYTES) {
          return yield* fail(`${file.path} is over ${MAX_FILE_BYTES / 1024} KB.`);
        }
      }
    });

  const save = (change: ProfileChange, by: string) =>
    lock.withPermits(1)(
      io(
        Effect.gen(function* () {
          yield* requireEditable;
          yield* requireProfile(change.name);
          yield* validateChange(change);
          yield* catchUp(change.name);
          const apply = (dir: string) =>
            Effect.gen(function* () {
              yield* applyFiles(dir, change.files ?? []);
              if (change.settings !== undefined) {
                const meta = path.join(dir, FILES.meta);
                const text = (yield* readOptional(meta)) ?? "";
                yield* fs.writeFileString(meta, applySettings(text, change.settings));
              }
            });
          const issues = yield* checkCopy(change.name, apply);
          const current = (yield* snapshots(change.name)).at(-1)?.version ?? 0;
          if (hasErrors(issues)) return { saved: false, version: current, issues };
          yield* apply(dirOf(change.name));
          const version = yield* record(
            change.name,
            by,
            change.summary?.trim() || describeChange(change),
          );
          yield* deliver;
          return { saved: true, version, issues } satisfies ProfileSaveResult;
        }),
      ),
    );

  const create = (input: ProfileCreateInput, by: string) =>
    lock.withPermits(1)(
      io(
        Effect.gen(function* () {
          yield* requireEditable;
          const dir = dirOf(input.name);
          if (yield* exists(dir)) return yield* fail(`A profile named ${input.name} exists.`);
          const description = input.description?.trim() || "A Magnesium agent.";
          if (input.copyOf !== undefined) {
            yield* requireProfile(input.copyOf);
            yield* writeBundle(dir, yield* bundleOf(input.copyOf));
            const meta = path.join(dir, FILES.meta);
            const doc = parseDocument((yield* readOptional(meta)) ?? "");
            doc.set("name", input.name);
            if (input.description !== undefined) doc.set("description", description);
            doc.delete("display_name");
            yield* fs.writeFileString(meta, doc.toString());
          } else {
            yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
            for (const [file, content] of Object.entries(
              profileTemplate(input.name, description),
            )) {
              yield* fs.writeFileString(path.join(dir, file), content);
            }
          }
          const issues = yield* withServices(
            checkProfile(yield* withServices(loadProfile(root, input.name))),
          );
          if (hasErrors(issues)) {
            yield* fs.remove(dir, { recursive: true, force: true });
            return { saved: false, version: 0, issues };
          }
          const version = yield* record(
            input.name,
            by,
            input.copyOf === undefined ? "Created" : `Created as a copy of ${input.copyOf}`,
          );
          yield* deliver;
          return { saved: true, version, issues } satisfies ProfileSaveResult;
        }),
      ),
    );

  /** `.trash/<name>__<ms>`: the folder as it was deleted. */
  const trashEntries = Effect.gen(function* () {
    const dir = path.join(root, TRASH_DIR);
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
    return entries.flatMap((entry) => {
      const match = /^([a-z][a-z0-9-]{0,31})__(\d+)$/.exec(entry);
      return match ? [{ entry, name: match[1]!, deletedAt: Number(match[2]) }] : [];
    });
  });
  const keepFor = PROFILE_TRASH_DAYS * 24 * 60 * 60 * 1000;

  const remove = (name: string, by: string) =>
    lock.withPermits(1)(
      io(
        Effect.gen(function* () {
          yield* requireEditable;
          yield* requireProfile(name);
          yield* catchUp(name);
          const at = DateTime.toEpochMillis(yield* DateTime.now);
          yield* fs.makeDirectory(path.join(root, TRASH_DIR), { recursive: true, mode: 0o700 });
          yield* fs.rename(dirOf(name), path.join(root, TRASH_DIR, `${name}__${at}`));
          yield* Effect.logInfo("Deleted a profile.", { name, by });
          yield* deliver;
        }),
      ),
    );

  const deleted = io(
    Effect.gen(function* () {
      const nowAt = DateTime.toEpochMillis(yield* DateTime.now);
      const kept: DeletedProfile[] = [];
      for (const item of yield* trashEntries) {
        const where = path.join(root, TRASH_DIR, item.entry);
        if (nowAt - item.deletedAt > keepFor) {
          // Gone for good, with its history.
          yield* fs.remove(where, { recursive: true, force: true });
          if (!(yield* exists(dirOf(item.name)))) {
            yield* fs.remove(historyOf(item.name), { recursive: true, force: true });
          }
          continue;
        }
        const profile = yield* withServices(loadProfile(path.join(root, TRASH_DIR), item.entry));
        kept.push({
          name: item.name,
          displayName: (profile.meta as ProfileMeta).display_name?.trim() || item.name,
          deletedAt: DateTime.formatIso(DateTime.makeUnsafe(item.deletedAt)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(item.deletedAt + keepFor)),
        });
      }
      return kept.toSorted((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    }),
  );

  const restore = (name: string, by: string) =>
    lock.withPermits(1)(
      io(
        Effect.gen(function* () {
          yield* requireEditable;
          const latest = (yield* trashEntries)
            .filter((item) => item.name === name)
            .toSorted((a, b) => b.deletedAt - a.deletedAt)[0];
          if (latest === undefined)
            return yield* fail(`No deleted profile named ${name} can be restored.`);
          if (yield* exists(dirOf(name))) {
            return yield* fail(`A profile named ${name} exists: rename or delete it first.`);
          }
          yield* fs.rename(path.join(root, TRASH_DIR, latest.entry), dirOf(name));
          yield* record(name, by, "Restored");
          yield* deliver;
        }),
      ),
    );

  const putBack = (input: ProfilePutBackInput, by: string) =>
    lock.withPermits(1)(
      io(
        Effect.gen(function* () {
          yield* requireEditable;
          yield* requireProfile(input.name);
          yield* catchUp(input.name);
          const target = (yield* snapshots(input.name)).find(
            (snapshot) => snapshot.version === input.version,
          );
          if (target === undefined)
            return yield* fail(`${input.name} has no version ${input.version}.`);
          const replace = (dir: string) =>
            Effect.gen(function* () {
              for (const file of (yield* withServices(bundleProfile(dir, input.name))).files) {
                yield* fs.remove(path.join(dir, ...file.path.split("/")), { force: true });
              }
              yield* writeBundle(dir, { name: input.name, files: target.files });
            });
          const issues = yield* checkCopy(input.name, replace);
          const current = (yield* snapshots(input.name)).at(-1)?.version ?? 0;
          if (hasErrors(issues)) return { saved: false, version: current, issues };
          yield* replace(dirOf(input.name));
          const version = yield* record(input.name, by, `Put back v${input.version}`);
          yield* deliver;
          return { saved: true, version, issues } satisfies ProfileSaveResult;
        }),
      ),
    );

  const textFile = (file: string, relative: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (
        Option.isNone(info) ||
        info.value.type !== "File" ||
        Number(info.value.size) > MAX_FILE_BYTES
      ) {
        return undefined;
      }
      const bytes = yield* fs.readFile(file);
      return { path: relative, content: decoder.decode(bytes) } satisfies ProfileTextFile;
    });

  const skillsOf = (dir: string) =>
    Effect.gen(function* () {
      const base = path.join(dir, FILES.skills);
      const names = yield* fs.readDirectory(base).pipe(Effect.orElseSucceed(() => [] as string[]));
      const skills: ProfileSkill[] = [];
      for (const name of names.toSorted()) {
        if (name.startsWith(".")) continue;
        const entries = yield* fs
          .readDirectory(path.join(base, name), { recursive: true })
          .pipe(Effect.orElseSucceed(() => [] as string[]));
        const files: ProfileTextFile[] = [];
        for (const entry of entries.toSorted()) {
          if (entry.split(path.sep).some((segment) => segment.startsWith("."))) continue;
          const file = yield* textFile(
            path.join(base, name, entry),
            [FILES.skills, name, ...entry.split(path.sep)].join("/"),
          );
          if (file !== undefined) files.push(file);
        }
        skills.push({
          name,
          description: skillDescription(
            files.find((file) => file.path.endsWith("/SKILL.md"))?.content,
          ),
          files,
        });
      }
      return skills;
    });

  const deliveriesOf = (name: string, targets: ReadonlyArray<string>, everyMachine: boolean) =>
    Effect.gen(function* () {
      if (Option.isNone(pusher)) return [] as ProfileDelivery[];
      const statuses = new Map<string, ProfilePushStatus>(
        (yield* pusher.value.status).map((status) => [status.machine, status]),
      );
      const names = everyMachine
        ? Option.isSome(machines)
          ? yield* machines.value.names
          : [...statuses.keys()]
        : targets;
      return names.map((machine): ProfileDelivery => {
        const status = statuses.get(machine);
        if (status === undefined) {
          return {
            machine,
            state: "offline",
            checkedAt: null,
            detail: "The hub hasn't reached it yet.",
          };
        }
        if (status.refused.includes(name)) {
          return {
            machine,
            state: "refused",
            checkedAt: status.checkedAt,
            detail: "It refused this version and keeps its last good one.",
          };
        }
        if (status.error !== null) {
          return {
            machine,
            state: status.error.includes("no access") ? "no-access" : "offline",
            checkedAt: status.checkedAt,
            detail: status.error,
          };
        }
        return status.current
          ? { machine, state: "current", checkedAt: status.checkedAt, detail: null }
          : {
              machine,
              state: "behind",
              checkedAt: status.checkedAt,
              detail: "A newer version is on its way.",
            };
      });
    });

  const detail = (name: string) =>
    io(
      Effect.gen(function* () {
        yield* requireProfile(name);
        const pushManaged = yield* withServices(isPushManaged(root));
        if (!pushManaged) yield* lock.withPermits(1)(catchUp(name));
        const profile = yield* withServices(loadProfile(root, name));
        const issues = yield* withServices(checkProfile(profile));
        const resolved = resolveProfile(profile);
        const summary = summarize(
          path,
          { profile, resolved, issues, ready: !hasErrors(issues) },
          config,
          pushManaged,
          yield* instances.instances,
        );
        const dir = dirOf(name);
        const top = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
        const files: ProfileTextFile[] = [];
        // AGENTS.md first, then the files with roles of their own, then the rest by name.
        const order = [FILES.agents, FILES.claude, FILES.conventions, FILES.memories];
        const markdown = top
          .filter((entry) => EXTRA_INSTRUCTIONS.test(entry))
          .toSorted((a, b) => {
            const ai = order.indexOf(a as (typeof order)[number]);
            const bi = order.indexOf(b as (typeof order)[number]);
            return (
              (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.localeCompare(b)
            );
          });
        for (const entry of markdown) {
          const file = yield* textFile(path.join(dir, entry), entry);
          if (file !== undefined) files.push(file);
        }
        const mcpJson = (yield* readOptional(path.join(dir, FILES.mcp))) ?? null;
        const servers =
          mcpJson === null
            ? {}
            : yield* decodeMcpFile(mcpJson).pipe(
                Effect.map((decoded) => decoded.mcpServers),
                Effect.orElseSucceed(() => ({})),
              );
        const mcpServers: ProfileMcpServer[] = [
          {
            name: MAGNESIUM_MCP_SERVER,
            how: "Magnesium's own tools, in every thread",
            secrets: [],
            permissions: resolved.toolPermissions[MAGNESIUM_MCP_SERVER] ?? OWN_SERVER_DEFAULTS,
          },
          ...Object.entries(servers).map(([server, value]) => ({
            name: server,
            how: howOf(value),
            secrets: secretsOf(value),
            permissions: resolved.toolPermissions[server] ?? {
              default: DEFAULT_TOOL_PERMISSION,
              tools: {},
            },
          })),
        ];
        const all = yield* snapshots(name);
        const history: ProfileVersion[] = all
          .slice(-MAX_HISTORY_SHOWN)
          .toReversed()
          .map(({ version, at, by, summary: line }) => ({ version, at, by, summary: line }));
        const everyMachine = resolved.machines.includes("*");
        return {
          summary,
          harnesses: resolved.harnesses as ReadonlyArray<ProfileHarness>,
          everyMachine,
          env: (profile.meta as ProfileMeta).env ?? [],
          launchArgs: launchArgList((profile.meta as ProfileMeta).launch_args),
          files,
          skills: yield* skillsOf(dir),
          mcpJson,
          hooksJson: (yield* readOptional(path.join(dir, FILES.hooks))) ?? null,
          mcpServers,
          version: all.at(-1)?.version ?? 0,
          history,
          deliveries: yield* deliveriesOf(
            name,
            resolved.machines.filter((machine) => machine !== "*"),
            everyMachine,
          ),
          editable: !pushManaged,
        } satisfies ProfileDetail;
      }),
    );

  const sendNow = Option.isSome(pusher) ? pusher.value.pushNow : Effect.void;

  return ProfileStore.of({ detail, save, create, remove, deleted, restore, putBack, sendNow });
});

export const layer = Layer.effect(ProfileStore, make);
