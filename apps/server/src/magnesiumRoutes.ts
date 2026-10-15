// magnesium: hands Magnesium's routes (magnesium/server) this server's auth, secrets and config (doc 11)
import {
  type CallerSession,
  CallerUnauthenticatedError,
  routesLayer,
  ServerPortError,
  ServerPorts,
} from "@magnesium/server";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const portError = (detail: string) => (cause: unknown) => new ServerPortError({ detail, cause });

/**
 * Subjects of sessions that came from pairing a device: a pairing link or
 * code, the startup link, the desktop bootstrap. The hub's machine routes take
 * only these, so a session the `t3` CLI mints (or the reusable dev token that
 * agents inherit in web dev mode) cannot reach the machines the hub carries.
 * Agents' `/mcp` tokens are not sessions and fail authentication outright.
 */
const PAIRED_SUBJECTS: ReadonlySet<string> = new Set([
  "one-time-token",
  EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
  "desktop-bootstrap",
]);

/** How Magnesium's routes see a caller, from upstream's auth. */
export const callerAuthentication = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => {
  const toCaller = (
    authenticated: Effect.Effect<
      EnvironmentAuth.AuthenticatedSession,
      EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError
    >,
  ) =>
    authenticated.pipe(
      Effect.map((session): CallerSession => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        expiresAt: session.expiresAt,
        paired: PAIRED_SUBJECTS.has(session.subject),
      })),
      Effect.mapError((error) =>
        EnvironmentAuth.isServerAuthCredentialError(error)
          ? new CallerUnauthenticatedError({ detail: error.message })
          : new ServerPortError({ detail: "Authentication failed.", cause: error }),
      ),
    );
  return {
    http: (request: HttpServerRequest.HttpServerRequest) =>
      toCaller(auth.authenticateHttpRequest(request)),
    webSocket: (request: HttpServerRequest.HttpServerRequest) =>
      toCaller(auth.authenticateWebSocketUpgrade(request)),
  };
};

const serverPortsLayer = Layer.effect(
  ServerPorts,
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const callers = callerAuthentication(auth);
    return ServerPorts.of({
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      authenticate: callers.http,
      authenticateWebSocket: callers.webSocket,
      environment: environment.getDescriptor,
      threads: {
        active: snapshots.getShellSnapshot().pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.mapError(portError("Could not read the threads.")),
        ),
        byId: (threadId) =>
          snapshots
            .getThreadShellById(threadId)
            .pipe(Effect.mapError(portError("Could not read a thread."))),
        changes: engine.streamDomainEvents.pipe(
          Stream.filter((event) => event.aggregateKind === "thread"),
          Stream.map((event) => ThreadId.make(event.aggregateId)),
        ),
      },
      issueBearerSession: (input) =>
        auth.issueSession(input).pipe(
          Effect.map((issued) => ({ token: issued.token, expiresAt: issued.expiresAt })),
          Effect.mapError(portError("Could not issue a session.")),
        ),
      getSecret: (name) =>
        secrets.get(name).pipe(Effect.mapError(portError(`Could not read ${name}.`))),
      setSecret: (name, value) =>
        secrets.set(name, value).pipe(Effect.mapError(portError(`Could not write ${name}.`))),
      removeSecret: (name) =>
        secrets.remove(name).pipe(Effect.mapError(portError(`Could not remove ${name}.`))),
    });
  }),
);

export const magnesiumRoutesLayer = routesLayer.pipe(Layer.provide(serverPortsLayer));
