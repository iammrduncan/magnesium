import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MagnesiumDb } from "../db/MagnesiumDb.ts";

/** The pins on Home, in `magnesium.sqlite`: an item's pin outlives a hub restart. */

const Pin = Schema.Struct({ key: Schema.String, pinnedAt: Schema.String });
const decodePins = Schema.decodeUnknownEffect(Schema.Array(Pin));

export const makePinStore = Effect.gen(function* () {
  const { sql } = yield* MagnesiumDb;
  return {
    load: sql`SELECT key, pinned_at AS "pinnedAt" FROM home_pins`.pipe(
      Effect.flatMap(decodePins),
      Effect.orDie,
    ),
    pin: (key: string, pinnedAt: string) =>
      sql`
        INSERT INTO home_pins (key, pinned_at) VALUES (${key}, ${pinnedAt})
        ON CONFLICT (key) DO UPDATE SET pinned_at = excluded.pinned_at`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    unpin: (key: string) =>
      sql`DELETE FROM home_pins WHERE key = ${key}`.pipe(Effect.asVoid, Effect.orDie),
  };
});
