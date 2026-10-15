// magnesium: hands Magnesium's routes (magnesium/server) this server's auth, secrets and config (doc 11)
import {
  CallerUnauthenticatedError,
  routesLayer,
  ServerPortError,
  ServerPorts,
} from "@magnesium/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";

const portError = (detail: string) => (cause: unknown) => new ServerPortError({ detail, cause });

const serverPortsLayer = Layer.effect(
  ServerPorts,
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    return ServerPorts.of({
      baseDir: config.baseDir,
      authenticate: (request) =>
        auth.authenticateHttpRequest(request).pipe(
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
        ),
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
