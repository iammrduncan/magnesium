import { IsoDateTime, NonNegativeInt } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * A server's own upkeep (goal 35): its backups, and changing or restoring what
 * it runs. Each server does these for itself; the hub only asks. Builds change
 * and backups come back while the server is stopped, by its launcher, so
 * nothing the server runs cuts the job off (`magnesium-release apply-pending`).
 */

/**
 * Where a machine takes a build the hub sends it: `PUT <path>/<release>` with
 * the pack as the body (`magnesium-release pack`), then `upkeep.update`.
 */
export const UPKEEP_RELEASES_PATH = "/api/magnesium/upkeep/releases";

/** A backup's folder under `<T3CODE_HOME>/backups`: the UTC time it was taken. */
export const BACKUP_NAME_PATTERN = /^\d{8}T\d{6}Z(-\d+)?$/;
export const BackupName = Schema.String.check(Schema.isPattern(BACKUP_NAME_PATTERN));
export type BackupName = typeof BackupName.Type;

/** A release, `magnesium-release`'s name for a build: a short commit. */
export const ReleaseName = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/));
export type ReleaseName = typeof ReleaseName.Type;

export const ServerBackup = Schema.Struct({
  name: BackupName,
  at: IsoDateTime,
  bytes: NonNegativeInt,
});
export type ServerBackup = typeof ServerBackup.Type;

/** A server's backups, newest first, and how many it keeps. */
export const BackupList = Schema.Struct({
  backups: Schema.Array(ServerBackup),
  keep: NonNegativeInt,
});
export type BackupList = typeof BackupList.Type;

/** What Fleet needs to say about a server's backups without listing them. */
export const BackupHealth = Schema.Struct({
  /** The newest backup's time; null when it has none. */
  newestAt: Schema.NullOr(IsoDateTime),
  /** The last backup that failed, when that is newer than the newest one. */
  failure: Schema.NullOr(Schema.Struct({ at: IsoDateTime, reason: Schema.String })),
});
export type BackupHealth = typeof BackupHealth.Type;

/**
 * What restarts this server and runs its pending work before each start:
 * `systemd` for the unit `magnesium-release` installs, `container` for a pod's
 * or an attached machine's entrypoint. Without one, the server can't stop
 * itself to update or restore.
 */
export const UpkeepLauncher = Schema.Literals(["systemd", "container"]);
export type UpkeepLauncher = typeof UpkeepLauncher.Type;

export const UpkeepKind = Schema.Literals(["update", "rollback", "restore", "backup"]);
export type UpkeepKind = typeof UpkeepKind.Type;

/** Work under way on a server, in a sentence for Fleet. */
export const UpkeepActivity = Schema.Struct({
  kind: UpkeepKind,
  text: Schema.String,
  since: IsoDateTime,
});
export type UpkeepActivity = typeof UpkeepActivity.Type;

/** How the last update, rollback or restore ended (`upkeep/result.json`). */
export const UpkeepResult = Schema.Struct({
  kind: UpkeepKind,
  /** The build it left; null for a restore. */
  from: Schema.NullOr(Schema.String),
  /** The build it went to, or the backup it put back. */
  to: Schema.NullOr(Schema.String),
  ok: Schema.Boolean,
  detail: Schema.String,
  at: IsoDateTime,
});
export type UpkeepResult = typeof UpkeepResult.Type;

export const BackupNameInput = Schema.Struct({ name: BackupName });
export type BackupNameInput = typeof BackupNameInput.Type;

/**
 * Switch to `release`. `build`: build it from this server's own source first,
 * for a machine that can't run the hub's build as it is (another OS or
 * processor); otherwise the release must already be here, sent by the hub.
 */
export const UpdateInput = Schema.Struct({
  release: ReleaseName,
  build: Schema.optionalKey(Schema.Boolean),
});
export type UpdateInput = typeof UpdateInput.Type;

export class UpkeepError extends Schema.TaggedError<UpkeepError>()("UpkeepError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
