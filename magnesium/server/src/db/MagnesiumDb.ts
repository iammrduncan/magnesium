import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerPorts } from "../ports.ts";
import { migrations } from "./migrations.ts";

/**
 * Magnesium's own database, `magnesium.sqlite`, next to upstream's
 * `state.sqlite` (doc 11). Upstream's migration ledger has no safe id range
 * for a fork, so ours is a separate file with its own migrations table, and
 * rows keep upstream ids as opaque strings. It sits behind its own service so
 * it never stands in for upstream's `SqlClient`.
 */

export const MAGNESIUM_DB_FILE = "magnesium.sqlite";
export const MIGRATIONS_TABLE = "magnesium_migrations";

export class MagnesiumDb extends Context.Service<
  MagnesiumDb,
  { readonly sql: SqlClient.SqlClient }
>()("@magnesium/server/db/MagnesiumDb") {}

const runMigrations = Migrator.make({});

/**
 * The database and its WAL files are the server user's alone (0600). SQLite
 * gives the -wal and -shm files the database file's mode, so the file is made
 * before SQLite opens it, and older files are tightened.
 */
const keepPrivate = (filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(filename))) {
      yield* fileSystem.writeFile(filename, new Uint8Array(), { mode: 0o600 });
    }
    for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (yield* fileSystem.exists(file)) yield* fileSystem.chmod(file, 0o600);
    }
  });

/** Opens `filename` (`:memory:` in tests) and brings it to the newest migration in `loader`. */
export const open = (filename: string, loader: Migrator.Loader = migrations) =>
  Effect.gen(function* () {
    if (filename !== ":memory:") yield* keepPrivate(filename);
    const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
    const sql = Context.get(context, SqlClient.SqlClient);
    const setup = Effect.gen(function* () {
      // Upstream's settings: wait out a busy writer, WAL, and a bounded -wal file.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA journal_size_limit = 33554432;`;
      const ran = yield* runMigrations({ loader, table: MIGRATIONS_TABLE });
      if (ran.length > 0) {
        yield* Effect.logInfo("Magnesium database migrated.", {
          migrations: ran.map(([id, name]) => `${id}_${name}`),
        });
      }
    });
    yield* setup.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return MagnesiumDb.of({ sql });
  });

export const layer = Layer.effect(
  MagnesiumDb,
  Effect.gen(function* () {
    const ports = yield* ServerPorts;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(ports.stateDir, { recursive: true });
    return yield* open(path.join(ports.stateDir, MAGNESIUM_DB_FILE));
  }),
);
