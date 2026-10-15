import type {
  AuthEnvironmentScope,
  ExecutionEnvironmentDescriptor,
  OrchestrationThreadShell,
  ServerAuthSessionMethod,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/unstable/http";

/** The server's threads, read from its projections. */
export interface ThreadPorts {
  /** Every active (not archived) thread. */
  readonly active: Effect.Effect<ReadonlyArray<OrchestrationThreadShell>, ServerPortError>;
  /** None once the thread is archived or deleted. */
  readonly byId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ServerPortError>;
  /** The id of each thread as its events commit; ids repeat. Attach before reading `active`. */
  readonly changes: Stream.Stream<ThreadId>;
}

/** The caller of one of our routes, as the host server authenticated it. */
export interface CallerSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAt: DateTime.DateTime | undefined;
}

export class CallerUnauthenticatedError extends Schema.TaggedError<CallerUnauthenticatedError>()(
  "CallerUnauthenticatedError",
  { detail: Schema.String },
) {}

export class ServerPortError extends Schema.TaggedError<ServerPortError>()("ServerPortError", {
  detail: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * What Magnesium's routes need from the T3 server they run in. `apps/server`
 * provides it from its own auth, secret store and config, so this package never
 * imports server internals (doc 11, "magnesium/server").
 */
export class ServerPorts extends Context.Service<
  ServerPorts,
  {
    /** The server's base directory (`T3CODE_HOME`). */
    readonly baseDir: string;
    /** Where the server keeps `state.sqlite`; `magnesium.sqlite` goes next to it. */
    readonly stateDir: string;
    /** Cookie or bearer only: a `wsTicket` on a proxied request belongs to the machine. */
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<CallerSession, CallerUnauthenticatedError | ServerPortError>;
    /** A WebSocket upgrade to one of our routes: a `wsTicket`, then cookie or bearer. */
    readonly authenticateWebSocket: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<CallerSession, CallerUnauthenticatedError | ServerPortError>;
    /** This server's identity, label and version. */
    readonly environment: Effect.Effect<ExecutionEnvironmentDescriptor>;
    readonly threads: ThreadPorts;
    readonly issueBearerSession: (input: {
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly label: string;
    }) => Effect.Effect<
      { readonly token: string; readonly expiresAt: DateTime.Utc },
      ServerPortError
    >;
    readonly getSecret: (name: string) => Effect.Effect<Option.Option<Uint8Array>, ServerPortError>;
    readonly setSecret: (name: string, value: Uint8Array) => Effect.Effect<void, ServerPortError>;
    readonly removeSecret: (name: string) => Effect.Effect<void, ServerPortError>;
  }
>()("@magnesium/server/ports/ServerPorts") {}
