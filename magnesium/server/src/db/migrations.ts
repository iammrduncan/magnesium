import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

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

/** Home (goal 06): the items you pinned to the top, by Home key. */
const homePins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE home_pins (
      key TEXT PRIMARY KEY,
      pinned_at TEXT NOT NULL
    )`;
});

/** Profiles (goal 34): changes agents asked for, waiting on the owner, and how each went. */
const profileRequests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE profile_requests (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      requested_by TEXT NOT NULL,
      input TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decision TEXT,
      note TEXT,
      decided_at TEXT
    )`;
});

/**
 * The hub's machines (goal 35): those added in the app, and those its deploy
 * config names that were forgotten in the app, which stay forgotten.
 */
const hubMachines = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE hub_machines (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      added_at TEXT NOT NULL
    )`;
  yield* sql`
    CREATE TABLE hub_machines_forgotten (
      name TEXT PRIMARY KEY,
      forgotten_at TEXT NOT NULL
    )`;
});

export const migrations = Migrator.fromRecord({
  "1_Fleet": fleet,
  "2_HomePins": homePins,
  "3_ProfileRequests": profileRequests,
  "4_HubMachines": hubMachines,
});
