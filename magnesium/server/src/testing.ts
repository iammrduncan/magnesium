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
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ShellThreadStatus,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  RuntimeRequestId,
  type ScheduledTask,
  type ServerAuthSessionMethod,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
} from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";

import { routesLayer } from "./index.ts";
import {
  CallerUnauthenticatedError,
  type CallerSession,
  type SchedulePorts,
  ServerPorts,
  type ThreadPorts,
  type ThreadRequestRecords,
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

const TEST_TIME = "2026-10-16T01:00:00.000Z";
const at = (iso: string) => DateTime.makeUnsafe(iso);

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A thread shell (Orchestrator V2) with what Magnesium reads; the rest is
 * empty. `run` is the latest run's status; a thread with none never ran.
 * `background` is work left running after the run: a monitor that will wake
 * the agent ("working"), or a command such as a dev server ("monitoring").
 */
export const testThread = (
  id: string,
  state: {
    readonly run?: OrchestrationV2ShellThreadStatus;
    readonly approval?: boolean;
    readonly question?: boolean;
    readonly background?: "working" | "monitoring";
    readonly lastError?: string;
  } = {},
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const runId = state.run === undefined ? null : RunId.make(`${id}-run`);
  const active = state.run !== undefined && ACTIVE.has(state.run);
  // A V2 shell names only its newest open request.
  const pending = state.approval
    ? { id: RuntimeRequestId.make(`${id}-approval`), kind: "command", createdAt: at(TEST_TIME) }
    : state.question
      ? {
          id: RuntimeRequestId.make(`${id}-question`),
          kind: "user_input",
          createdAt: at(TEST_TIME),
        }
      : null;
  return {
    createdBy: "user",
    creationSource: "web",
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    providerInstanceId: "opencode",
    modelSelection: { instanceId: "opencode", model: "test-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: runId,
    latestRunStartedAt: runId === null ? null : at(TEST_TIME),
    latestRunCompletedAt: runId === null || active ? null : at(TEST_TIME),
    activeRunId: active ? runId : null,
    status: state.run ?? "idle",
    lastError: state.lastError ?? null,
    pendingRuntimeRequest: pending,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks:
      state.background === undefined
        ? []
        : [
            {
              taskId: "background-1",
              kind: state.background === "working" ? "monitor" : "command",
            },
          ],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at(TEST_TIME),
    updatedAt: at(TEST_TIME),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
};

const turnItemBase = (threadId: string, id: string, updatedAt: string, runId: string | null) => ({
  id,
  threadId: ThreadId.make(threadId),
  runId: runId === null ? null : RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: at(updatedAt),
  completedAt: at(updatedAt),
  updatedAt: at(updatedAt),
});

const pendingRequest = (
  requestId: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
  createdAt: string,
) =>
  ({
    id: RuntimeRequestId.make(requestId),
    nodeId: "node-1",
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session-1" },
    createdAt: at(createdAt),
    resolvedAt: null,
  }) as unknown as OrchestrationV2RuntimeRequest;

/** A thread's requests and plans, as `ThreadPorts.requests` reads them. */
export const testThreadRequests = (
  ...parts: ReadonlyArray<Partial<ThreadRequestRecords>>
): ThreadRequestRecords => ({
  runtimeRequests: parts.flatMap((part) => part.runtimeRequests ?? []),
  plans: parts.flatMap((part) => part.plans ?? []),
  turnItems: parts.flatMap((part) => part.turnItems ?? []),
});

/** The agent asks to run `command`, as a provider's request reaches the thread. */
export const approvalRequest = (
  threadId: string,
  requestId: string,
  createdAt: string,
  command = "rm -rf build",
): Pick<ThreadRequestRecords, "runtimeRequests" | "turnItems"> => ({
  runtimeRequests: [pendingRequest(requestId, "command", createdAt)],
  turnItems: [
    {
      ...turnItemBase(threadId, `item-${requestId}`, createdAt, null),
      type: "approval_request",
      requestId: RuntimeRequestId.make(requestId),
      requestKind: "command",
      prompt: command,
    } as unknown as OrchestrationV2TurnItem,
  ],
});

/** The agent asks one question with these options. */
export const questionRequest = (
  threadId: string,
  requestId: string,
  createdAt: string,
  options: ReadonlyArray<string> = ["Suite A", "Needle tests only"],
): Pick<ThreadRequestRecords, "runtimeRequests" | "turnItems"> => ({
  runtimeRequests: [pendingRequest(requestId, "user_input", createdAt)],
  turnItems: [
    {
      ...turnItemBase(threadId, `item-${requestId}`, createdAt, null),
      type: "user_input_request",
      requestId: RuntimeRequestId.make(requestId),
      questions: [
        {
          id: "eval-set",
          header: "Eval set",
          question: "Which eval set should the run use?",
          options: options.map((label) => ({ label, description: `${label}, described.` })),
          multiSelect: false,
        },
      ],
    } as unknown as OrchestrationV2TurnItem,
  ],
});

/** A proposed plan on `runId`, written at `updatedAt`; `status` "completed" once implemented. */
export const proposedPlan = (
  threadId: string,
  planId: string,
  runId: string,
  updatedAt: string,
  markdown: string,
  status: OrchestrationV2PlanArtifact["status"] = "active",
): Pick<ThreadRequestRecords, "plans" | "turnItems"> => ({
  plans: [
    {
      id: planId,
      threadId: ThreadId.make(threadId),
      runId: RunId.make(runId),
      nodeId: "node-1",
      status,
      kind: "proposed_plan",
      markdown,
    } as unknown as OrchestrationV2PlanArtifact,
  ],
  turnItems: [
    {
      ...turnItemBase(threadId, `item-${planId}`, updatedAt, runId),
      type: "proposed_plan",
      planId,
      markdown,
      streaming: false,
    } as unknown as OrchestrationV2TurnItem,
  ],
});

/** A finished command in a run, for Detail. */
export const commandItem = (
  threadId: string,
  id: string,
  runId: string,
  completedAt: string,
  input: string,
): OrchestrationV2TurnItem =>
  ({
    ...turnItemBase(threadId, id, completedAt, runId),
    type: "command_execution",
    input,
  }) as unknown as OrchestrationV2TurnItem;

/**
 * In-memory threads that announce each change, like the server's projections.
 * A thread's requests and run items are set with it; commands are recorded, never run.
 */
export const makeTestThreads = Effect.gen(function* () {
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const requests = new Map<ThreadId, ThreadRequestRecords>();
  const work = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem>>();
  /** Scheduled task ids by `<thread>/<run>`. */
  const startedBy = new Map<string, string>();
  const projects: Array<OrchestrationProjectShell> = [];
  const dispatched: Array<OrchestrationV2Command> = [];
  const changes = yield* PubSub.unbounded<ThreadId>();
  const ports: ThreadPorts = {
    active: Effect.sync(() => [...threads.values()]),
    byId: (threadId) => Effect.sync(() => Option.fromNullishOr(threads.get(threadId))),
    changes: Stream.fromPubSub(changes),
    requests: (threadId) =>
      Effect.sync(() =>
        threads.has(threadId)
          ? Option.some(requests.get(threadId) ?? testThreadRequests())
          : Option.none(),
      ),
    recentWork: (threadId, runId) =>
      Effect.sync(() => (work.get(threadId) ?? []).filter((item) => item.runId === runId)),
    scheduledTaskOf: (threadId, runId) =>
      Effect.sync(() => Option.fromNullishOr(startedBy.get(`${threadId}/${runId}`))),
    projects: Effect.sync(() => [...projects]),
    dispatch: (command) => Effect.sync(() => void dispatched.push(command)),
  };
  return {
    ports,
    dispatched,
    upsert: (
      thread: OrchestrationV2ThreadShell,
      threadRequests?: ThreadRequestRecords,
      runItems?: ReadonlyArray<OrchestrationV2TurnItem>,
    ) =>
      Effect.sync(() => {
        threads.set(thread.id, thread);
        if (threadRequests === undefined) requests.delete(thread.id);
        else requests.set(thread.id, threadRequests);
        if (runItems === undefined) work.delete(thread.id);
        else work.set(thread.id, runItems);
      }).pipe(Effect.andThen(PubSub.publish(changes, thread.id))),
    remove: (id: string) =>
      Effect.sync(() => threads.delete(ThreadId.make(id))).pipe(
        Effect.andThen(PubSub.publish(changes, ThreadId.make(id))),
      ),
    addProject: (project: OrchestrationProjectShell) =>
      Effect.sync(() => void projects.push(project)),
    /** Marks a run as started by a scheduled task; set it before the thread's upsert. */
    startedByTask: (threadId: string, runId: string, taskId: string) =>
      Effect.sync(() => void startedBy.set(`${threadId}/${runId}`, taskId)),
  };
});

/** Settings for tests that do not look at provider instances: the defaults, and writes go nowhere. */
export const defaultSettingsPorts = {
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
  setProviderInstances: () => Effect.void,
  // And no scheduled tasks.
  schedule: {
    tasks: Stream.make([]).pipe(Stream.concat(Stream.never)),
    runNow: () => Effect.void,
  },
} satisfies Pick<ServerPorts["Service"], "getSettings" | "setProviderInstances" | "schedule">;

/** A scheduler with no tasks, for tests that do not look at them. */
export const noSchedule: SchedulePorts = {
  tasks: Stream.make([]).pipe(Stream.concat(Stream.never)),
  runNow: () => Effect.void,
};

/** In-memory scheduled tasks that announce each change, like upstream's scheduler. */
export const makeTestSchedule = Effect.gen(function* () {
  let tasks: ReadonlyArray<ScheduledTask> = [];
  const ran: Array<string> = [];
  const changes = yield* PubSub.unbounded<ReadonlyArray<ScheduledTask>>();
  const ports: SchedulePorts = {
    tasks: Stream.concat(
      Stream.suspend(() => Stream.make(tasks)),
      Stream.fromPubSub(changes),
    ),
    runNow: (taskId) => Effect.sync(() => void ran.push(taskId)),
  };
  return {
    ports,
    ran,
    set: (next: ReadonlyArray<ScheduledTask>) =>
      Effect.sync(() => {
        tasks = next;
      }).pipe(Effect.andThen(PubSub.publish(changes, next))),
  };
});

/** A scheduled task with only what Home reads. */
export const testScheduledTask = (
  id: string,
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask =>
  ({
    id,
    title: id,
    prompt: "Run it.",
    enabled: true,
    projectId: "project-1",
    threadId: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    nextRunAt: "2026-10-16T14:00:00.000Z",
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    ...overrides,
  }) as unknown as ScheduledTask;

/** Threads that never change, for tests that do not look at them. */
export const noThreads: ThreadPorts = {
  active: Effect.succeed([]),
  byId: () => Effect.succeedNone,
  changes: Stream.never,
  requests: () => Effect.succeedNone,
  recentWork: () => Effect.succeed([]),
  scheduledTaskOf: () => Effect.succeedNone,
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
