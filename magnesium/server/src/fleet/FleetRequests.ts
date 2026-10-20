import {
  type FleetRequest,
  FleetRequestInput,
  fleetRequestTarget,
  UpkeepError,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { requesterOf } from "../agents/requester.ts";
import { MagnesiumDb } from "../db/MagnesiumDb.ts";
import { HubMachines } from "../hub/HubMachines.ts";
import { HubSpokes } from "../hub/HubSpokes.ts";
import { ServerPorts } from "../ports.ts";
import { Fleet } from "./Fleet.ts";
import { FleetUpkeep } from "./FleetUpkeep.ts";

/**
 * Changes to the fleet that agents ask for (goal 35, D66). An agent asks
 * through its tools; the request waits here, in `magnesium.sqlite`, shows on
 * Home, and is carried out by this server's own Fleet only when the owner
 * approves it. One that fails when approved stays waiting, with the reason on
 * the card, to try again or turn down.
 */
export class FleetRequests extends Context.Service<
  FleetRequests,
  {
    /** `threadId` is the asking agent's thread, when it asks from one. */
    readonly ask: (
      input: FleetRequestInput,
      threadId: string | null,
    ) => Effect.Effect<FleetRequest, UpkeepError>;
    readonly get: (id: string) => Effect.Effect<FleetRequest, UpkeepError>;
    /** The requests that wait on the owner, now and after each change. */
    readonly pending: Stream.Stream<ReadonlyArray<FleetRequest>>;
    /** Approving carries the change out first; turning it down changes nothing. */
    readonly decide: (id: string, approve: boolean) => Effect.Effect<void, UpkeepError>;
  }
>()("@magnesium/server/fleet/FleetRequests") {}

const InputJson = Schema.fromJsonString(FleetRequestInput);
const decodeInput = Schema.decodeUnknownEffect(InputJson);
const encodeInput = Schema.encodeEffect(InputJson);

const Row = Schema.Struct({
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  requestedBy: Schema.String,
  input: Schema.String,
  createdAt: Schema.String,
  decision: Schema.NullOr(Schema.Literals(["approved", "rejected"])),
  note: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const fail = (detail: string) => new UpkeepError({ detail });

export const make = Effect.gen(function* () {
  const { sql } = yield* MagnesiumDb;
  const ports = yield* ServerPorts;
  const crypto = yield* Crypto.Crypto;
  const fleet = yield* Fleet;
  const upkeep = yield* FleetUpkeep;
  const machines = yield* HubMachines;
  const spokes = yield* HubSpokes;
  const changed = yield* PubSub.unbounded<void>();

  const toRequest = (row: typeof Row.Type) =>
    decodeInput(row.input).pipe(
      Effect.map((input): FleetRequest => ({
        id: row.id,
        threadId: row.threadId,
        requestedBy: row.requestedBy,
        input,
        createdAt: row.createdAt,
        decision: row.decision,
        note: row.note,
      })),
    );

  const select = (where: "pending" | { readonly id: string }) =>
    (where === "pending"
      ? sql`SELECT id, thread_id AS "threadId", requested_by AS "requestedBy", input, created_at AS "createdAt", decision, note
            FROM fleet_requests WHERE decision IS NULL ORDER BY created_at`
      : sql`SELECT id, thread_id AS "threadId", requested_by AS "requestedBy", input, created_at AS "createdAt", decision, note
            FROM fleet_requests WHERE id = ${where.id}`
    ).pipe(
      Effect.flatMap(decodeRows),
      Effect.flatMap((rows) => Effect.forEach(rows, toRequest)),
      Effect.orDie,
    );

  /** What's wrong with a request before anyone looks at it, or undefined. */
  const problemOf = (input: FleetRequestInput) =>
    Effect.gen(function* () {
      if (input.summary.trim() === "") return "Say in a line what the change is for.";
      const names = new Set((yield* fleet.machines).map((machine) => machine.name));
      if (input._tag === "add-machine") {
        return names.has(input.name)
          ? `Fleet already has a machine named ${input.name}.`
          : undefined;
      }
      const target = fleetRequestTarget(input);
      if (target !== null && !names.has(target))
        return `There is no server named ${target} in Fleet.`;
      return undefined;
    });

  const ask = (input: FleetRequestInput, threadId: string | null) =>
    Effect.gen(function* () {
      const problem = yield* problemOf(input);
      if (problem !== undefined) return yield* fail(problem);
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const requestedBy = yield* requesterOf(ports, threadId);
      const text = yield* encodeInput(input).pipe(Effect.orDie);
      yield* sql`
        INSERT INTO fleet_requests (id, thread_id, requested_by, input, created_at)
        VALUES (${id}, ${threadId}, ${requestedBy}, ${text}, ${createdAt})`.pipe(Effect.orDie);
      yield* PubSub.publish(changed, undefined);
      return {
        id,
        threadId,
        requestedBy,
        input,
        createdAt,
        decision: null,
        note: null,
      } satisfies FleetRequest;
    });

  const get = (id: string) =>
    select({ id }).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail("There's no such request."))
          : Effect.succeed(rows[0]),
      ),
    );

  /** Carries a request out on this server's Fleet; answers what happened, in a sentence. */
  const carryOut = (input: FleetRequestInput): Effect.Effect<string, UpkeepError> => {
    const server = fleetRequestTarget(input);
    const asUpkeep = (error: { readonly detail: string }) => fail(error.detail);
    switch (input._tag) {
      case "update":
        return upkeep
          .update(server)
          .pipe(Effect.as("The update is under way; Fleet shows how it goes."));
      case "rollback":
        return upkeep
          .rollback(server)
          .pipe(Effect.as("The rollback is under way; Fleet shows how it goes."));
      case "backup-now":
        return upkeep
          .backupNow(server)
          .pipe(Effect.map((backup) => `Backed up as ${backup.name}.`));
      case "restore":
        return upkeep
          .restore(server, input.backup)
          .pipe(Effect.as("The restore is under way; Fleet shows how it goes."));
      case "add-machine":
        return machines
          .add({ name: input.name, url: input.url, pairingCode: input.pairingCode })
          .pipe(Effect.as(`${input.name} is in Fleet.`), Effect.mapError(asUpkeep));
      case "forget-machine":
        return machines.forget(input.server).pipe(
          Effect.as(`Forgot ${input.server}.`),
          Effect.catchTags({
            HubMachineNotFoundError: () => Effect.fail(fail(`${input.server} isn't in Fleet.`)),
          }),
          Effect.mapError(asUpkeep),
        );
      case "edit-pod":
        return spokes
          .edit(input.server, {
            ...(input.node === undefined ? {} : { node: input.node }),
            ...(input.opencode === undefined ? {} : { opencode: input.opencode }),
            ...(input.keys === undefined ? {} : { keys: input.keys }),
          })
          .pipe(
            Effect.as(`${input.server}'s pod restarts to take the change.`),
            Effect.mapError(asUpkeep),
          );
    }
  };

  const decide = (id: string, approve: boolean) =>
    Effect.gen(function* () {
      const request = yield* get(id);
      if (request.decision !== null) return yield* fail("That request was already decided.");
      // A change that fails stays waiting, to try again or turn down.
      const note = approve ? yield* carryOut(request.input) : null;
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      const decision = approve ? "approved" : "rejected";
      yield* sql`
        UPDATE fleet_requests SET decision = ${decision}, note = ${note}, decided_at = ${decidedAt}
        WHERE id = ${id}`.pipe(Effect.orDie);
      yield* PubSub.publish(changed, undefined);
    });

  const pending = Stream.unwrap(
    Effect.gen(function* () {
      // Listen before reading, so a request made during the read isn't missed.
      const signals = yield* PubSub.subscribe(changed);
      return Stream.concat(
        Stream.fromEffect(select("pending")),
        Stream.fromSubscription(signals).pipe(Stream.mapEffect(() => select("pending"))),
      );
    }),
  );

  return FleetRequests.of({ ask, get, pending, decide });
});

export const layer = Layer.effect(FleetRequests, make);
