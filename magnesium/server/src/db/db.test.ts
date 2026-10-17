// @effect-diagnostics nodeBuiltinImport:off - a temporary database file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { MIGRATIONS_TABLE, open } from "./MagnesiumDb.ts";

const tempFile = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-db-"))),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => NodePath.join(dir, "magnesium.sqlite")));

const sample = Migrator.fromRecord({
  "1_Notes": Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.pipe(Effect.asVoid),
  ),
});

describe("magnesium.sqlite", () => {
  it.live("keeps its own migrations table and runs each migration once", () =>
    Effect.gen(function* () {
      const file = yield* tempFile;
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* open(file, sample);
          yield* db.sql`INSERT INTO notes (body) VALUES ('kept')`;
          const tables = yield* db.sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
          const mode = yield* db.sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
          return { tables: tables.map((row) => row.name), mode: mode[0]?.journal_mode };
        }),
      );
      expect(first.tables).toContain(MIGRATIONS_TABLE);
      expect(first.tables).toContain("notes");
      // Never upstream's ledger: the fork has no safe id range in it.
      expect(first.tables).not.toContain("effect_sql_migrations");
      expect(first.mode).toBe("wal");

      // Opening again finds the schema current and the data kept.
      const notes = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* open(file, sample);
          return yield* db.sql<{ readonly body: string }>`SELECT body FROM notes`;
        }),
      );
      expect(notes.map((row) => row.body)).toEqual(["kept"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("is the server user's alone, and so are its WAL files", () =>
    Effect.gen(function* () {
      const modeOf = (file: string) =>
        Effect.promise(() => NodeFSP.stat(file)).pipe(Effect.map((stat) => stat.mode & 0o777));

      const fresh = yield* tempFile;
      const files = yield* Effect.scoped(
        Effect.gen(function* () {
          const db = yield* open(fresh, sample);
          yield* db.sql`INSERT INTO notes (body) VALUES ('private')`;
          return yield* Effect.forEach([fresh, `${fresh}-wal`, `${fresh}-shm`], modeOf);
        }),
      );
      expect(files).toEqual([0o600, 0o600, 0o600]);

      // A database an older build made 0644 is tightened when opened.
      const older = yield* tempFile;
      yield* Effect.promise(() => NodeFSP.writeFile(older, new Uint8Array(), { mode: 0o644 }));
      yield* Effect.promise(() => NodeFSP.chmod(older, 0o644));
      yield* Effect.scoped(open(older, sample));
      expect(yield* modeOf(older)).toBe(0o600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
