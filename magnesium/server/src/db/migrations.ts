import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `magnesium.sqlite`'s migrations, run in id order at startup. Keys are
 * `<id>_<name>`; add the next id, never change one that has shipped. Each runs
 * with the database's `SqlClient`.
 */

/** Fleet (goal 04): what the hub last knew of each machine, and its links' history. */
const fleet = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fleet_machines (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      environment_id TEXT,
      server_version TEXT,
      last_seen_at TEXT
    )`;
  yield* sql`
    CREATE TABLE fleet_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      machine TEXT NOT NULL,
      link TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    )`;
});

export const migrations = Migrator.fromRecord({
  "1_Fleet": fleet,
});
