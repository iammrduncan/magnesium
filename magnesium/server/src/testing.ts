// @effect-diagnostics globalDate:off nodeBuiltinImport:off - fixtures stand in for a server, its clock and its state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { MAGNESIUM_WS_PATH } from "@magnesium/contracts";
import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type ExecutionEnvironmentDescriptor,
  EnvironmentId,
  type OrchestrationThreadShell,
  type ServerAuthSessionMethod,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, type HttpServerRequest } from "effect/unstable/http";
import type * as NetAddress from "effect/unstable/net/NetAddress";

import { routesLayer } from "./index.ts";
import {
  CallerUnauthenticatedError,
  type CallerSession,
  ServerPorts,
  type ThreadPorts,
} from "./ports.ts";

/** Test fixtures for `ServerPorts`: a fake server's sessions, identity and threads. */

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("env-test");

export const testDescriptor = (
  overrides: Partial<ExecutionEnvironmentDescriptor> = {},
): ExecutionEnvironmentDescriptor => ({
  environmentId: TEST_ENVIRONMENT_ID,
  label: "cpu-host-1",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.45",
  capabilities: { repositoryIdentity: true },
  ...overrides,
});

/** Session names a test can present as a cookie (`t3_session`) or a `wsTicket`. */
export const TEST_SESSION_SCOPES: Readonly<Record<string, ReadonlyArray<AuthEnvironmentScope>>> = {
  admin: AuthAdministrativeScopes,
  operator: AuthStandardClientScopes,
  reader: [AuthOrchestrationReadScope],
  nobody: [],
};

const sessionNamed = (name: string | undefined): CallerSession | undefined => {
  if (name === undefined) return undefined;
  const scopes = TEST_SESSION_SCOPES[name];
  if (scopes === undefined) return undefined;
  return {
    sessionId: `session-${name}`,
    subject: name,
    method: "browser-session-cookie" as ServerAuthSessionMethod,
    scopes,
    expiresAt: undefined,
  };
};

/** Authenticates a `wsTicket` query parameter, then the `t3_session` cookie, by session name. */
export const authenticateTestSocket = (request: HttpServerRequest.HttpServerRequest) => {
  const ticket = new URL(request.url, "http://test").searchParams.get("wsTicket") ?? undefined;
  const session = sessionNamed(ticket) ?? sessionNamed(request.cookies.t3_session);
  return session === undefined
    ? Effect.fail(new CallerUnauthenticatedError({ detail: "no session" }))
    : Effect.succeed(session);
};

/** A thread shell with only what Magnesium reads; the rest is never looked at. */
export const testThread = (
  id: string,
  state: {
    readonly session?: "running" | "starting" | "ready" | "idle";
    readonly approval?: boolean;
    readonly question?: boolean;
    readonly background?: "working" | "monitoring";
  } = {},
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    title: id,
    session:
      state.session === undefined
        ? null
        : { threadId: ThreadId.make(id), status: state.session, activeTurnId: null },
    hasPendingApprovals: state.approval ?? false,
    hasPendingUserInput: state.question ?? false,
    hasActionableProposedPlan: false,
    backgroundLiveness: state.background ?? null,
  }) as unknown as OrchestrationThreadShell;

/** In-memory threads that announce each change, like the server's projections. */
export const makeTestThreads = Effect.gen(function* () {
  const threads = new Map<ThreadId, OrchestrationThreadShell>();
  const changes = yield* PubSub.unbounded<ThreadId>();
  const ports: ThreadPorts = {
    active: Effect.sync(() => [...threads.values()]),
    byId: (threadId) => Effect.sync(() => Option.fromNullishOr(threads.get(threadId))),
    changes: Stream.fromPubSub(changes),
  };
  return {
    ports,
    upsert: (thread: OrchestrationThreadShell) =>
      Effect.sync(() => threads.set(thread.id, thread)).pipe(
        Effect.andThen(PubSub.publish(changes, thread.id)),
      ),
    remove: (id: string) =>
      Effect.sync(() => threads.delete(ThreadId.make(id))).pipe(
        Effect.andThen(PubSub.publish(changes, ThreadId.make(id))),
      ),
  };
});

/** Threads that never change, for tests that do not look at them. */
export const noThreads: ThreadPorts = {
  active: Effect.succeed([]),
  byId: () => Effect.succeedNone,
  changes: Stream.never,
};

/**
 * Every Magnesium route on a real socket, with a fake host server behind the
 * ports and its state in a temporary directory, for the life of the scope.
 * `routes` adds stand-ins for upstream routes a test needs.
 */
export const startTestServer = (
  options: {
    readonly routes?: Layer.Layer<never, never, HttpRouter.HttpRouter>;
    readonly ports?: Partial<ServerPorts["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-server-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const ports = ServerPorts.of({
      baseDir: stateDir,
      stateDir,
      authenticate: authenticateTestSocket,
      authenticateWebSocket: authenticateTestSocket,
      environment: Effect.succeed(testDescriptor()),
      threads: noThreads,
      issueBearerSession: () => Effect.die("unused"),
      getSecret: () => Effect.succeedNone,
      setSecret: () => Effect.void,
      removeSecret: () => Effect.void,
      ...options.ports,
    });
    const context = yield* Layer.build(
      HttpRouter.serve(Layer.mergeAll(routesLayer, options.routes ?? Layer.empty), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(Layer.succeed(ServerPorts, ports)),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const address = Context.get(context, HttpServer.HttpServer).address as NetAddress.InetAddress;
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      stateDir,
      origin,
      wsUrl: (ticket?: string) =>
        `ws://127.0.0.1:${address.port}${MAGNESIUM_WS_PATH}${ticket ? `?wsTicket=${ticket}` : ""}`,
    };
  });
