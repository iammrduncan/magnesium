import type { AuthEnvironmentScope, ServerAuthSessionMethod } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/unstable/http";

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
    /** Cookie or bearer only: a `wsTicket` on a proxied request belongs to the machine. */
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<CallerSession, CallerUnauthenticatedError | ServerPortError>;
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
