// @effect-diagnostics globalDate:off globalDateInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off - fixtures stand in for a server, its clock and its state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MAGNESIUM_WS_PATH } from "@magnesium/contracts";
import {
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  DEFAULT_SERVER_SETTINGS,
  type ExecutionEnvironmentDescriptor,
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
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
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
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
  /** Minted by the `t3` CLI, or the reusable dev token: every scope, but not a paired device. */
  cli: AuthAdministrativeScopes,
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
    paired: name !== "cli",
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
    readonly session?: "running" | "starting" | "ready" | "idle" | "error";
    readonly approval?: boolean;
    readonly question?: boolean;
    readonly background?: "working" | "monitoring";
  } = {},
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: "project-1",
    title: id,
    interactionMode: "default",
    runtimeMode: "approval-required",
    modelSelection: { instanceId: "opencode", model: "test-model" },
    session:
      state.session === undefined
        ? null
        : {
            threadId: ThreadId.make(id),
            status: state.session,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-10-16T01:00:00.000Z",
          },
    latestTurn: null,
    hasPendingApprovals: state.approval ?? false,
    hasPendingUserInput: state.question ?? false,
    hasActionableProposedPlan: false,
    backgroundLiveness: state.background ?? null,
    settledAt: null,
    updatedAt: "2026-10-16T01:00:00.000Z",
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

/** A thread's detail with only what Home reads: its activities and plans. */
export const testThreadDetail = (
  id: string,
  detail: {
    readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
    readonly proposedPlans?: ReadonlyArray<OrchestrationProposedPlan>;
  } = {},
): OrchestrationThread =>
  ({
    id: ThreadId.make(id),
    activities: detail.activities ?? [],
    proposedPlans: detail.proposedPlans ?? [],
    latestTurn: null,
  }) as unknown as OrchestrationThread;

/** The agent asks to run `command`, as a provider's request reaches the thread. */
export const approvalActivity = (
  requestId: string,
  createdAt: string,
  command = "rm -rf build",
): OrchestrationThreadActivity =>
  ({
    id: `event-${requestId}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: {
      requestId,
      requestKind: "command",
      requestType: "command_execution_approval",
      detail: command,
    },
    turnId: null,
    createdAt,
  }) as unknown as OrchestrationThreadActivity;

/** The agent asks one question with these options. */
export const questionActivity = (
  requestId: string,
  createdAt: string,
  options: ReadonlyArray<string> = ["Suite A", "Needle tests only"],
): OrchestrationThreadActivity =>
  ({
    id: `event-${requestId}`,
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: {
      requestId,
      questions: [
        {
          id: "eval-set",
          header: "Eval set",
          question: "Which eval set should the run use?",
          options: options.map((label) => ({ label, description: `${label}, described.` })),
          multiSelect: false,
        },
      ],
    },
    turnId: null,
    createdAt,
  }) as unknown as OrchestrationThreadActivity;

/**
 * In-memory threads that announce each change, like the server's projections.
 * A thread's detail is set with it; commands are recorded, never run.
 */
export const makeTestThreads = Effect.gen(function* () {
  const threads = new Map<ThreadId, OrchestrationThreadShell>();
  const details = new Map<ThreadId, OrchestrationThread>();
  const projects: Array<OrchestrationProjectShell> = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const changes = yield* PubSub.unbounded<ThreadId>();
  const ports: ThreadPorts = {
    active: Effect.sync(() => [...threads.values()]),
    byId: (threadId) => Effect.sync(() => Option.fromNullishOr(threads.get(threadId))),
    changes: Stream.fromPubSub(changes),
    detail: (threadId) =>
      Effect.sync(() =>
        threads.has(threadId) ? Option.fromNullishOr(details.get(threadId)) : Option.none(),
      ),
    projects: Effect.sync(() => [...projects]),
    dispatch: (command) => Effect.sync(() => void dispatched.push(command)),
  };
  return {
    ports,
    dispatched,
    upsert: (thread: OrchestrationThreadShell, detail?: OrchestrationThread) =>
      Effect.sync(() => {
        threads.set(thread.id, thread);
        if (detail === undefined) details.delete(thread.id);
        else details.set(thread.id, detail);
      }).pipe(Effect.andThen(PubSub.publish(changes, thread.id))),
    remove: (id: string) =>
      Effect.sync(() => threads.delete(ThreadId.make(id))).pipe(
        Effect.andThen(PubSub.publish(changes, ThreadId.make(id))),
      ),
    addProject: (project: OrchestrationProjectShell) =>
      Effect.sync(() => void projects.push(project)),
  };
});

/** Settings for tests that do not look at provider instances: the defaults, and writes go nowhere. */
export const defaultSettingsPorts = {
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  setProviderInstances: () => Effect.void,
} satisfies Pick<ServerPorts["Service"], "getSettings" | "setProviderInstances">;

/** Threads that never change, for tests that do not look at them. */
export const noThreads: ThreadPorts = {
  active: Effect.succeed([]),
  byId: () => Effect.succeedNone,
  changes: Stream.never,
  detail: () => Effect.succeedNone,
  projects: Effect.succeed([]),
  dispatch: () => Effect.void,
};

/**
 * Upstream's ticket route on a machine: `token` (the hub's) buys a ticket for
 * the paired `operator` session; anything else gets 401.
 */
export const testTicketRoute = (token: string) =>
  HttpRouter.add(
    "POST",
    "/api/auth/websocket-ticket",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== `Bearer ${token}`) {
        return HttpServerResponse.jsonUnsafe({ error: "nope" }, { status: 401 });
      }
      return HttpServerResponse.jsonUnsafe({
        ticket: "operator",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }),
  );

/** A hub's secret store holding `token` for each named machine, as `HubMachines` writes it. */
export const testHubSecrets =
  (tokens: Readonly<Record<string, string>>) =>
  (name: string): Effect.Effect<Option.Option<Uint8Array>> => {
    const machine = name.replace(/^magnesium-hub-machine-/, "");
    const token = tokens[machine];
    if (token === undefined || machine === name) return Effect.succeedNone;
    const stored = JSON.stringify({
      token,
      environmentId: TEST_ENVIRONMENT_ID,
      label: machine,
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    return Effect.succeedSome(new TextEncoder().encode(stored));
  };

/** `hub-machines.json` for a hub that carries these machines. */
export const testHubConfig = (machines: Readonly<Record<string, string>>) =>
  JSON.stringify({
    machines: Object.entries(machines).map(([name, url]) => ({ name, url })),
  });

/**
 * Every Magnesium route on a real socket, with a fake host server behind the
 * ports and its state in a temporary directory, for the life of the scope.
 * `routes` adds stand-ins for upstream routes a test needs.
 */
export const startTestServer = (
  options: {
    readonly routes?: Layer.Layer<never, never, HttpRouter.HttpRouter>;
    readonly ports?: Partial<ServerPorts["Service"]>;
    /** Files written into the server's base directory before it starts, such as `hub-machines.json`. */
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-server-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    for (const [name, content] of Object.entries(options.files ?? {})) {
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(stateDir, name), content));
    }
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
      ...defaultSettingsPorts,
      ...options.ports,
    });
    // Closing the scope drops every socket first, WebSockets included, the way
    // a stopped server does; Node's own close would wait for them.
    const server = NodeHttp.createServer();
    const sockets = new Set<NodeNet.Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const context = yield* Layer.build(
      HttpRouter.serve(Layer.mergeAll(routesLayer, options.routes ?? Layer.empty), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(ServerPorts, ports), FetchHttpClient.layer)),
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" })),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
      }),
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
