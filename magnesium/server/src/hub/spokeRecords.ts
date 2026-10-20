import { HubMachineName, SpokeSpec } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The spokes the hub runs through gateways (goal 25), in `<T3CODE_HOME>/hub-spokes.json`.
 * The hub writes this file itself; the deploy config's `hub-machines.json` is
 * Ansible's. Both are read on every request, and a spoke here replaces a
 * machine of the same name there, so moving a machine into Kubernetes changes
 * only the hub's own file.
 */

export const HUB_SPOKES_FILE = "hub-spokes.json";

export const SpokeRecord = Schema.Struct({
  name: HubMachineName,
  gateway: HubMachineName,
  /** Where the hub reaches it: `<gateway>/spokes/<name>`. */
  url: Schema.String,
  spec: SpokeSpec,
  keys: Schema.Array(Schema.String),
  /** The build it ran before its build last changed, for Fleet's Roll back (goal 35). */
  previousBuild: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type SpokeRecord = typeof SpokeRecord.Type;

/**
 * Machines attached inside workloads' pods (D59), in `<T3CODE_HOME>/hub-attached.json`:
 * reached through a gateway like a spoke, run by the workload's own deploy.
 * One here also replaces a deploy-config machine of the same name.
 */
export const HUB_ATTACHED_FILE = "hub-attached.json";

export const AttachedRecord = Schema.Struct({
  name: HubMachineName,
  gateway: HubMachineName,
  /** Where the hub reaches it: `<gateway>/spokes/<name>`. */
  url: Schema.String,
  /** The workload it runs in, as its gateway says. */
  workload: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Found through its gateway (its route is labelled), rather than attached by hand. */
  discovered: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AttachedRecord = typeof AttachedRecord.Type;

/** One of the hub's own record files: a JSON object with one array, written whole. */
const recordFile = <S extends Schema.Top>(fileName: string, key: string, record: S) => {
  const File = Schema.fromJsonString(Schema.Struct({ [key]: Schema.Array(record) }));
  const decode = Schema.decodeUnknownEffect(File);
  const encode = Schema.encodeEffect(File);
  type Records = ReadonlyArray<S["Type"]>;

  /** The records; none when the file is missing or unreadable (which is logged). */
  const read = (baseDir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(baseDir, fileName);
      return yield* fs.readFileString(file).pipe(
        Effect.flatMap(decode),
        Effect.map((content) => (content as Record<string, Records>)[key] ?? []),
        Effect.catch((error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound"
            ? Effect.succeed([] as Records)
            : Effect.logWarning("Could not read the hub's records.", { file, error }).pipe(
                Effect.as([] as Records),
              ),
        ),
      );
    });

  /** Replaces the records, all at once: a crash leaves the old file or the new one. */
  const write = (baseDir: string, records: Records) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(baseDir, fileName);
      const json = yield* encode({ [key]: records } as never).pipe(Effect.orDie);
      const partial = `${file}.partial`;
      yield* fs.writeFileString(partial, `${json}\n`, { mode: 0o600 });
      yield* fs.rename(partial, file);
    });

  return { read, write };
};

const spokeFile = recordFile(HUB_SPOKES_FILE, "spokes", SpokeRecord);
const attachedFile = recordFile(HUB_ATTACHED_FILE, "attached", AttachedRecord);

/** The hub's spokes; none when the file is missing or unreadable (which is logged). */
export const readSpokeRecords = spokeFile.read;
/** Replaces the hub's spokes, all at once. */
export const writeSpokeRecords = spokeFile.write;
/** The hub's attached machines; none when the file is missing or unreadable. */
export const readAttachedRecords = attachedFile.read;
/** Replaces the hub's attached machines, all at once. */
export const writeAttachedRecords = attachedFile.write;
