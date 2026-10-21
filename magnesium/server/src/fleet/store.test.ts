import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { MagnesiumDb, open } from "../db/MagnesiumDb.ts";
import { makeFleetStore } from "./store.ts";

describe("what the hub keeps of Fleet", () => {
  it.live("remembers what a machine is and runs, for one that doesn't answer after a restart", () =>
    Effect.gen(function* () {
      const db = yield* open(":memory:");
      const store = yield* makeFleetStore.pipe(Effect.provideService(MagnesiumDb, db));
      yield* store.saveSeen({
        name: "cpu-host-2",
        label: "cpu-host-2",
        environmentId: null,
        serverVersion: "0.0.45",
        lastSeenAt: "2026-10-20T03:22:00.000Z",
        kind: "machine",
        release: "1a2b3c4d5e",
        deployment: "pod",
        node: "node-b",
        workload: null,
      });
      // One the hub saw before it kept these.
      yield* db.sql`
        INSERT INTO fleet_machines (name, label, environment_id, server_version, last_seen_at)
        VALUES ('gpu-host-1', 'gpu-host-1', NULL, '0.0.44', NULL)`;

      expect(yield* store.loadSeen).toEqual([
        expect.objectContaining({ name: "cpu-host-2", deployment: "pod", release: "1a2b3c4d5e" }),
        expect.objectContaining({ name: "gpu-host-1", kind: null, deployment: null }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
