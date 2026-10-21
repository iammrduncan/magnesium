import { FleetEvent, ServerDeployment } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MagnesiumDb } from "../db/MagnesiumDb.ts";
import type { LogStore } from "../stream/LiveLog.ts";

/** What the hub keeps of Fleet in `magnesium.sqlite`, so a hub restart remembers when each machine was last seen. */

/** Link events kept; older ones are pruned. */
const KEEP_EVENTS = 5_000;
const PRUNE_EVERY = 100;

const SeenMachine = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  serverVersion: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
  // What it is and runs, as it last said; null for one seen before the hub kept them.
  kind: Schema.NullOr(Schema.Literals(["machine", "gateway"])),
  release: Schema.NullOr(Schema.String),
  deployment: Schema.NullOr(ServerDeployment),
  node: Schema.NullOr(Schema.String),
  workload: Schema.NullOr(Schema.String),
});
export type SeenMachine = typeof SeenMachine.Type;

const decodeSeen = Schema.decodeUnknownEffect(Schema.Array(SeenMachine));
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(FleetEvent));

export type FleetEventInput = Omit<FleetEvent, "sequence">;

export const makeFleetStore = Effect.gen(function* () {
  const { sql } = yield* MagnesiumDb;

  const loadSeen = sql`
    SELECT name, label, environment_id AS "environmentId", server_version AS "serverVersion",
      last_seen_at AS "lastSeenAt", kind, release, deployment, node, workload
    FROM fleet_machines`.pipe(Effect.flatMap(decodeSeen), Effect.orDie);

  const saveSeen = (machine: SeenMachine) =>
    sql`
      INSERT INTO fleet_machines (name, label, environment_id, server_version, last_seen_at,
        kind, release, deployment, node, workload)
      VALUES (${machine.name}, ${machine.label}, ${machine.environmentId},
        ${machine.serverVersion}, ${machine.lastSeenAt}, ${machine.kind}, ${machine.release},
        ${machine.deployment}, ${machine.node}, ${machine.workload})
      ON CONFLICT (name) DO UPDATE SET
        label = excluded.label,
        environment_id = excluded.environment_id,
        server_version = excluded.server_version,
        last_seen_at = excluded.last_seen_at,
        kind = excluded.kind,
        release = excluded.release,
        deployment = excluded.deployment,
        node = excluded.node,
        workload = excluded.workload`.pipe(Effect.asVoid, Effect.orDie);

  const selectEvents = <E>(rows: Effect.Effect<ReadonlyArray<unknown>, E>) =>
    rows.pipe(Effect.flatMap(decodeEvents), Effect.orDie);

  const prune = (sequence: number) =>
    sequence % PRUNE_EVERY === 0
      ? sql`DELETE FROM fleet_events WHERE sequence <= ${sequence - KEEP_EVENTS}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        )
      : Effect.void;

  const events: LogStore<FleetEvent, FleetEventInput> = {
    append: (inputs) =>
      Effect.forEach(inputs, (input) =>
        sql<{ readonly sequence: number }>`
          INSERT INTO fleet_events (machine, link, detail, at)
          VALUES (${input.machine}, ${input.link}, ${input.detail}, ${input.at})
          RETURNING sequence`.pipe(
          Effect.orDie,
          Effect.map((rows): FleetEvent => ({ ...input, sequence: Number(rows[0]!.sequence) })),
          Effect.tap((event) => prune(event.sequence)),
        ),
      ),
    latest: (limit) =>
      selectEvents(sql`
        SELECT sequence, machine, link, detail, at FROM fleet_events
        ORDER BY sequence DESC LIMIT ${limit}`).pipe(Effect.map((rows) => rows.toReversed())),
    before: (sequence, limit) =>
      selectEvents(sql`
        SELECT sequence, machine, link, detail, at FROM fleet_events
        WHERE sequence < ${sequence} ORDER BY sequence DESC LIMIT ${limit}`).pipe(
        Effect.map((rows) => rows.toReversed()),
      ),
    after: (sequence, limit) =>
      selectEvents(sql`
        SELECT sequence, machine, link, detail, at FROM fleet_events
        WHERE sequence > ${sequence} ORDER BY sequence ASC LIMIT ${limit}`),
    head: sql<{ readonly head: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS head FROM fleet_events`.pipe(
      Effect.map((rows) => Number(rows[0]?.head ?? 0)),
      Effect.orDie,
    ),
  };

  return { loadSeen, saveSeen, events };
});
