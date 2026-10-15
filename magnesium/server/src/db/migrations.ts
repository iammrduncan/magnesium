import * as Migrator from "effect/unstable/sql/Migrator";

/**
 * `magnesium.sqlite`'s migrations, run in id order at startup. Keys are
 * `<id>_<name>`; add the next id, never change one that has shipped. Each runs
 * with the database's `SqlClient`.
 */
export const migrations = Migrator.fromRecord({});
