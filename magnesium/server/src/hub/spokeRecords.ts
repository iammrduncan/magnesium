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
});
export type SpokeRecord = typeof SpokeRecord.Type;

const SpokesFile = Schema.fromJsonString(Schema.Struct({ spokes: Schema.Array(SpokeRecord) }));
const decodeFile = Schema.decodeUnknownEffect(SpokesFile);
const encodeFile = Schema.encodeEffect(SpokesFile);

/** The hub's spokes; none when the file is missing or unreadable (which is logged). */
export const readSpokeRecords = (baseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(baseDir, HUB_SPOKES_FILE);
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeFile),
      Effect.map((content) => content.spokes),
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed([] as ReadonlyArray<SpokeRecord>)
          : Effect.logWarning("Could not read the hub's spokes.", { file, error }).pipe(
              Effect.as([] as ReadonlyArray<SpokeRecord>),
            ),
      ),
    );
  });

/** Replaces the hub's spokes, all at once: a crash leaves the old file or the new one. */
export const writeSpokeRecords = (baseDir: string, records: ReadonlyArray<SpokeRecord>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(baseDir, HUB_SPOKES_FILE);
    const json = yield* encodeFile({ spokes: records }).pipe(Effect.orDie);
    const partial = `${file}.partial`;
    yield* fs.writeFileString(partial, `${json}\n`, { mode: 0o600 });
    yield* fs.rename(partial, file);
  });
