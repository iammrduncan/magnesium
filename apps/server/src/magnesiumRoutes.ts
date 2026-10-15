// magnesium: hands Magnesium's routes (magnesium/server) this server's auth, secrets and config (doc 11)
import {
  CallerUnauthenticatedError,
  routesLayer,
  ServerPortError,
  ServerPorts,
} from "@magnesium/server";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

const portError = (detail: string) => (cause: unknown) => new ServerPortError({ detail, cause });

const serverPortsLayer = Layer.effect(
  ServerPorts,
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const toCaller = (
      authenticated: Effect.Effect<
        EnvironmentAuth.AuthenticatedSession,
        EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError
      >,
    ) =>
      authenticated.pipe(
        Effect.map((session) => ({
          sessionId: session.sessionId,
          subject: session.subject,
          method: session.method,
          scopes: session.scopes,
          expiresAt: session.expiresAt,
        })),
        Effect.mapError((error) =>
          EnvironmentAuth.isServerAuthCredentialError(error)
            ? new CallerUnauthenticatedError({ detail: error.message })
            : new ServerPortError({ detail: "Authentication failed.", cause: error }),
        ),
      );
    return ServerPorts.of({
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      authenticate: (request) => toCaller(auth.authenticateHttpRequest(request)),
      authenticateWebSocket: (request) => toCaller(auth.authenticateWebSocketUpgrade(request)),
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
