// magnesium: hands Magnesium's routes (magnesium/server) this server's auth, secrets, config and provider instances (doc 11)
import {
  type CallerSession,
  CallerUnauthenticatedError,
  RECENT_WORK_ITEM_TYPES,
  routesLayer,
  ServerPortError,
  ServerPorts,
} from "@magnesium/server";
import { AuthSessionId, AuthStandardClientScopes, ScheduledTaskId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as AuthPairingLinks from "./persistence/AuthPairingLinks.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "./serverSettings.ts";

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

/**
 * A pairing code from the environment (goal 25), stored the way `t3 auth
 * pairing create` stores one, so exchanging it is the usual one-time pairing.
 * A code ever registered here, used or not, is left alone.
 */
export const registerPairingCode = (
  pairingLinks: AuthPairingLinks.AuthPairingLinkRepository["Service"],
  crypto: Crypto.Crypto,
  input: { readonly code: string; readonly label: string; readonly expiresAt: DateTime.Utc },
) =>
  Effect.gen(function* () {
    const existing = yield* pairingLinks.getByCredential({ credential: input.code });
    if (Option.isSome(existing)) return false;
    yield* pairingLinks.create({
      id: yield* crypto.randomUUIDv4(),
      credential: input.code,
      method: "one-time-token",
      scopes: AuthStandardClientScopes,
      subject: "one-time-token",
      label: input.label,
      proofKeyThumbprint: null,
      createdAt: yield* DateTime.now,
      expiresAt: input.expiresAt,
    });
    return true;
  });

const serverPortsLayer = Layer.effect(
  ServerPorts,
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
    const callers = callerAuthentication(auth);
    const settings = yield* ServerSettings.ServerSettingsService;
    const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
    const crypto = yield* Crypto.Crypto;
    return ServerPorts.of({
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      port: config.port,
      authenticate: callers.http,
      authenticateWebSocket: callers.webSocket,
      environment: environment.getDescriptor,
      threads: {
        active: threads.getShellSnapshot({ location: "active" }).pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.mapError(portError("Could not read the threads.")),
        ),
        byId: (threadId) =>
          threads.getThreadShell(threadId).pipe(
            Effect.map((shell) =>
              Option.filter(Option.fromNullishOr(shell), (found) => found.archivedAt === null),
            ),
            Effect.mapError(portError("Could not read a thread.")),
          ),
        // Live tail only: a reader attaches first, then reads `active`.
        changes: threads.streamDomainEvents.pipe(
          Stream.map((event) => event.threadId),
          Stream.orDie,
        ),
        // Only the turn items that describe requests and plans, filtered in SQL.
        requests: (threadId) =>
          threads.getThreadShell(threadId).pipe(
            Effect.flatMap((shell) =>
              shell === null || shell.archivedAt !== null
                ? Effect.succeedNone
                : threads
                    .getThreadRecords(threadId, ["runtimeRequests", "plans", "turnItems"], {
                      turnItemTypes: ["approval_request", "user_input_request", "proposed_plan"],
                    })
                    .pipe(Effect.map(Option.some)),
            ),
            Effect.mapError(portError("Could not read a thread.")),
          ),
        recentWork: (threadId, runId) =>
          threads
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: [runId],
              turnItemTypes: [...RECENT_WORK_ITEM_TYPES],
              turnItemStatuses: ["completed", "failed"],
            })
            .pipe(
              Effect.map((records) => records.turnItems),
              Effect.mapError(portError("Could not read a thread.")),
            ),
        scheduledTaskOf: (threadId, runId) =>
          threads
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: [runId],
              turnItemTypes: ["user_message"],
            })
            .pipe(
              Effect.map((records) =>
                Option.fromNullishOr(
                  records.turnItems.flatMap((item) =>
                    item.type === "user_message" && item.scheduledTaskId !== undefined
                      ? [item.scheduledTaskId]
                      : [],
                  )[0],
                ),
              ),
              Effect.mapError(portError("Could not read a thread.")),
            ),
        projects: projects
          .listShells()
          .pipe(Effect.mapError(portError("Could not read the projects."))),
        dispatch: (command) =>
          threads.dispatch(command).pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new ServerPortError({
                  detail:
                    userFacingDispatchErrorMessage(cause) ?? "Could not send that to the thread.",
                  cause,
                }),
            ),
          ),
      },
      schedule: {
        tasks: scheduledTasks.subscribeList().pipe(
          Stream.map((list) => list.tasks),
          Stream.mapError(portError("Could not read the scheduled tasks.")),
        ),
        runNow: (taskId) =>
          scheduledTasks.runNow({ id: ScheduledTaskId.make(taskId) }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new ServerPortError({ detail: cause.message, cause })),
          ),
      },
      issueBearerSession: (input) =>
        auth.issueSession(input).pipe(
          Effect.map((issued) => ({ token: issued.token, expiresAt: issued.expiresAt })),
          Effect.mapError(portError("Could not issue a session.")),
        ),
      endSession: (sessionId) =>
        auth
          .revokeSession(AuthSessionId.make(sessionId))
          .pipe(Effect.asVoid, Effect.mapError(portError("Could not end the session."))),
      registerPairingCode: (input) =>
        registerPairingCode(pairingLinks, crypto, input).pipe(
          Effect.mapError(portError("Could not register the pairing code.")),
        ),
      getSecret: (name) =>
        secrets.get(name).pipe(Effect.mapError(portError(`Could not read ${name}.`))),
      setSecret: (name, value) =>
        secrets.set(name, value).pipe(Effect.mapError(portError(`Could not write ${name}.`))),
      removeSecret: (name) =>
        secrets.remove(name).pipe(Effect.mapError(portError(`Could not remove ${name}.`))),
      // Profile sync starts with the server; wait until settings.json has been read.
      getSettings: settings.ready.pipe(
        Effect.andThen(settings.getSettings),
        Effect.mapError(portError("Could not read the settings.")),
      ),
      setProviderInstances: (providerInstances) =>
        settings.ready.pipe(
          Effect.andThen(settings.updateSettings({ providerInstances })),
          Effect.asVoid,
          Effect.mapError(portError("Could not write the settings.")),
        ),
    });
  }),
);

export const magnesiumRoutesLayer = routesLayer.pipe(Layer.provide(serverPortsLayer));
