import {
  parseProfileInstanceId,
  PROFILE_NAME_PATTERN,
  ProfileError,
  type ProfileIssue,
  type ProfileRequest,
  ProfileRequestInput,
} from "@magnesium/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { MagnesiumDb } from "../db/MagnesiumDb.ts";
import { ServerPorts } from "../ports.ts";
import { pathProblem, ProfileStore } from "./ProfileStore.ts";

/**
 * Changes agents ask for (goal 34, D65). An agent on any server asks through
 * its tools; the request waits here, in `magnesium.sqlite`, shows on Home, and
 * is applied by the hub only when the owner approves it. Where this server
 * keeps the profiles itself, a request is checked as it arrives, so an agent
 * hears at once that its change wouldn't pass.
 */
export class ProfileRequests extends Context.Service<
  ProfileRequests,
  {
    /** `threadId` is the asking agent's thread, when it asks from one. */
    readonly ask: (
      input: ProfileRequestInput,
      threadId: string | null,
    ) => Effect.Effect<ProfileRequest, ProfileError>;
    readonly get: (id: string) => Effect.Effect<ProfileRequest, ProfileError>;
    /** The requests that wait on the owner, now and after each change. */
    readonly pending: Stream.Stream<ReadonlyArray<ProfileRequest>>;
    readonly decide: (
      id: string,
      decision: "approved" | "rejected",
      note: string | null,
    ) => Effect.Effect<void, ProfileError>;
  }
>()("@magnesium/server/profiles/ProfileRequests") {}

/** A change an owner can read on a card and approve: its files stay small. */
const MAX_REQUEST_BYTES = 64 * 1024;

const InputJson = Schema.fromJsonString(ProfileRequestInput);
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

const fail = (detail: string) => Effect.fail(new ProfileError({ detail }));
const encoder = new TextEncoder();

/** What's wrong with a request before anyone looks at it, or undefined. */
export const requestProblem = (input: ProfileRequestInput): string | undefined => {
  if (!PROFILE_NAME_PATTERN.test(input.name)) return `${input.name} isn't a profile name.`;
  if (input.summary.trim() === "") return "Say in a line what the change is for.";
  for (const file of input.files ?? []) {
    const problem = pathProblem(file.path);
    if (problem !== undefined) return problem;
  }
  const bytes = encoder.encode(JSON.stringify(input)).length;
  if (bytes > MAX_REQUEST_BYTES) {
    return `The change is over ${MAX_REQUEST_BYTES / 1024} KB; ask for it in smaller steps.`;
  }
  if (input.kind === "update" && (input.files ?? []).length === 0 && input.settings === undefined) {
    return "An update names files or settings to change.";
  }
  return undefined;
};

/** The change, in a few lines an owner can read on a card. */
export const previewOf = (input: ProfileRequestInput): string => {
  if (input.kind === "delete") return `Delete ${input.name}`;
  if (input.kind === "create") {
    return input.copyOf === undefined
      ? `Create ${input.name}${input.description ? `: ${input.description}` : ""}`
      : `Create ${input.name} as a copy of ${input.copyOf}`;
  }
  const lines: string[] = [];
  for (const file of input.files ?? []) {
    if (file.content === null) {
      lines.push(`- ${file.path}`);
      continue;
    }
    lines.push(`+ ${file.path}`);
    // A file's final newline is no line of its own.
    for (const line of file.content.replace(/\n$/, "").split("\n").slice(0, 6)) {
      lines.push(`+   ${line}`);
    }
  }
  for (const [key, value] of Object.entries(input.settings ?? {})) {
    lines.push(`~ ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n").slice(0, 2_000);
};

export const make = Effect.gen(function* () {
  const { sql } = yield* MagnesiumDb;
  const ports = yield* ServerPorts;
  const store = yield* ProfileStore;
  const crypto = yield* Crypto.Crypto;
  const changed = yield* PubSub.unbounded<void>();

  const toRequest = (row: typeof Row.Type) =>
    decodeInput(row.input).pipe(
      Effect.map((input): ProfileRequest => ({
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
            FROM profile_requests WHERE decision IS NULL ORDER BY created_at`
      : sql`SELECT id, thread_id AS "threadId", requested_by AS "requestedBy", input, created_at AS "createdAt", decision, note
            FROM profile_requests WHERE id = ${where.id}`
    ).pipe(
      Effect.flatMap(decodeRows),
      Effect.flatMap((rows) => Effect.forEach(rows, toRequest)),
      Effect.orDie,
    );

  /** The asking agent's profile, from its thread's provider instance, or its harness. */
  const requesterOf = (threadId: string | null) =>
    Effect.gen(function* () {
      if (threadId === null) return "An agent outside Magnesium";
      const shell = yield* ports.threads
        .byId(ThreadId.make(threadId))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(shell)) return "An agent";
      const instance = shell.value.providerInstanceId;
      return parseProfileInstanceId(instance)?.profile ?? `An agent on ${instance}`;
    });

  /** What the check says here, when this server keeps the profiles. */
  const checkHere = (input: ProfileRequestInput) =>
    Effect.gen(function* () {
      if (!(yield* store.editable)) return [] as ReadonlyArray<ProfileIssue>;
      if (input.kind === "create" || input.kind === "delete") {
        const exists = yield* store.detail(input.name).pipe(Effect.option);
        if (input.kind === "create" && Option.isSome(exists)) {
          return yield* fail(`A profile named ${input.name} exists.`);
        }
        if (input.kind === "delete" && Option.isNone(exists)) {
          return yield* fail(`There's no profile named ${input.name}.`);
        }
        return [];
      }
      return yield* store.check({
        name: input.name,
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(input.settings === undefined ? {} : { settings: input.settings }),
      });
    });

  const ask = (input: ProfileRequestInput, threadId: string | null) =>
    Effect.gen(function* () {
      const problem = requestProblem(input);
      if (problem !== undefined) return yield* fail(problem);
      const errors = (yield* checkHere(input)).filter((issue) => issue.level === "error");
      if (errors.length > 0) {
        return yield* fail(
          `The check refuses it: ${errors.map((issue) => `${issue.file}: ${issue.message}`).join(" ")}`,
        );
      }
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const requestedBy = yield* requesterOf(threadId);
      const text = yield* encodeInput(input).pipe(Effect.orDie);
      yield* sql`
        INSERT INTO profile_requests (id, thread_id, requested_by, input, created_at)
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
      } satisfies ProfileRequest;
    });

  const get = (id: string) =>
    select({ id }).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? fail("There's no such request.") : Effect.succeed(rows[0]),
      ),
    );

  const decide = (id: string, decision: "approved" | "rejected", note: string | null) =>
    Effect.gen(function* () {
      const request = yield* get(id);
      if (request.decision !== null) return yield* fail("That request was already decided.");
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE profile_requests SET decision = ${decision}, note = ${note}, decided_at = ${decidedAt}
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

  return ProfileRequests.of({ ask, get, pending, decide });
});

export const layer = Layer.effect(ProfileRequests, make);
