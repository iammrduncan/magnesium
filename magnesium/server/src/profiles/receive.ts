import type {
  ProfileBundle,
  ProfileIssue,
  ProfilePush,
  ProfilePushResult,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProfilesConfig, REVISION_FILE } from "./catalog.ts";
import {
  checkProfile,
  FILES,
  hasErrors,
  listProfileNames,
  loadProfile,
  STATE_DIR,
} from "./profileFolder.ts";

/**
 * A machine taking its profiles from the hub (D39). A push is the whole set the
 * machine should hold. The receiving side trusts nothing in it: every profile is
 * checked here as sync would, written through a staging folder, and only then
 * swapped in. A refused profile keeps its last good copy. A profile's
 * `.magnesium/` (its homes, with the agents' sessions) is never touched, even
 * when the profile goes.
 */

const MAX_FILES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const INCOMING_DIR = ".incoming";
/** Plain relative paths: no dot-folders (`.git`, `.magnesium`), no `..`, no odd characters. */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/;

const refuse = (message: string): ProfileIssue => ({ level: "error", file: "push", message });

/** What is wrong with a bundle's shape, before anything touches the disk. */
export const bundleIssues = (bundle: ProfileBundle): ProfileIssue[] => {
  const issues: ProfileIssue[] = [];
  if (bundle.files.length > MAX_FILES) issues.push(refuse(`More than ${MAX_FILES} files.`));
  let total = 0;
  const seen = new Set<string>();
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    if (!segments.every((segment) => SAFE_SEGMENT.test(segment)) || segments.includes("..")) {
      issues.push(refuse(`Refused path "${file.path}".`));
      continue;
    }
    if (seen.has(file.path)) issues.push(refuse(`${file.path} is in the push twice.`));
    seen.add(file.path);
    if (file.executable === true && segments[0] !== FILES.skills) {
      issues.push(refuse(`${file.path}: only files under skills/ may be executable.`));
    }
    const bytes = Math.floor((file.contentBase64.length * 3) / 4);
    if (bytes > MAX_FILE_BYTES) issues.push(refuse(`${file.path} is over 1 MiB.`));
    total += bytes;
  }
  if (total > MAX_PROFILE_BYTES) issues.push(refuse("The profile is over 4 MiB."));
  for (const required of [FILES.meta, FILES.agents]) {
    if (!seen.has(required)) issues.push(refuse(`${required} is missing.`));
  }
  return issues;
};

/** Empty a profile folder except its `.magnesium/`. */
const clearProfile = Effect.fn("profiles.clearProfile")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as string[]))) {
    if (entry !== STATE_DIR)
      yield* fs.remove(path.join(dir, entry), { recursive: true, force: true });
  }
});

const stage = Effect.fn("profiles.stage")(function* (incoming: string, bundle: ProfileBundle) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectory({ directory: incoming, prefix: `${bundle.name}-` });
  const dir = path.join(root, bundle.name);
  for (const file of bundle.files) {
    const target = path.join(dir, file.path);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const bytes = yield* Effect.fromResult(Base64.decode(file.contentBase64));
    yield* fs.writeFile(target, bytes, { mode: file.executable === true ? 0o755 : 0o644 });
  }
  return { root, dir };
});

export class ProfilePushRefusedError extends Schema.TaggedError<ProfilePushRefusedError>()(
  "ProfilePushRefusedError",
  { message: Schema.String },
) {}

export const receivePush = Effect.fn("profiles.receivePush")(function* (push: ProfilePush) {
  const config = yield* ProfilesConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The hub's folder is the owner's source of truth; nothing overwrites it.
  if (config.isHub) {
    return yield* new ProfilePushRefusedError({
      message: "This server is the hub: it holds the profiles and takes no push.",
    });
  }
  const folder = config.folder;
  const incoming = path.join(folder, INCOMING_DIR);
  yield* fs.makeDirectory(incoming, { recursive: true, mode: 0o700 });

  const accepted: string[] = [];
  const refused: Array<{ name: string; issues: ReadonlyArray<ProfileIssue> }> = [];
  const names = new Set<string>();
  for (const bundle of push.profiles) {
    if (names.has(bundle.name)) {
      refused.push({ name: bundle.name, issues: [refuse("The profile is in the push twice.")] });
      continue;
    }
    names.add(bundle.name);
    const shape = bundleIssues(bundle);
    if (hasErrors(shape)) {
      refused.push({ name: bundle.name, issues: shape });
      continue;
    }
    const staged = yield* stage(incoming, bundle).pipe(Effect.result);
    if (staged._tag === "Failure") {
      refused.push({ name: bundle.name, issues: [refuse("Could not write the profile.")] });
      continue;
    }
    const { root, dir } = staged.success;
    const issues = yield* checkProfile(yield* loadProfile(root, bundle.name));
    if (hasErrors(issues)) {
      refused.push({ name: bundle.name, issues });
      yield* fs.remove(root, { recursive: true, force: true });
      continue;
    }
    const target = path.join(folder, bundle.name);
    yield* fs.makeDirectory(target, { recursive: true, mode: 0o700 });
    yield* clearProfile(target);
    for (const entry of yield* fs.readDirectory(dir)) {
      yield* fs.rename(path.join(dir, entry), path.join(target, entry));
    }
    yield* fs.remove(root, { recursive: true, force: true });
    accepted.push(bundle.name);
  }

  const removed: string[] = [];
  for (const name of yield* listProfileNames(folder)) {
    if (names.has(name)) continue;
    yield* clearProfile(path.join(folder, name));
    removed.push(name);
  }
  yield* fs.writeFileString(path.join(folder, REVISION_FILE), `${push.revision}\n`, {
    mode: 0o600,
  });
  if (accepted.length > 0 || refused.length > 0 || removed.length > 0) {
    yield* Effect.logInfo("Received profiles from the hub.", {
      revision: push.revision,
      accepted,
      refused: refused.map((profile) => profile.name),
      removed,
    });
  }
  return { revision: push.revision, accepted, refused, removed } satisfies ProfilePushResult;
});

/** The revision of the last push this machine took, or null before the first. */
export const readRevision = Effect.gen(function* () {
  const config = yield* ProfilesConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(config.folder, REVISION_FILE))
    .pipe(Effect.orElseSucceed(() => ""));
  return { revision: text.trim() || null };
});
