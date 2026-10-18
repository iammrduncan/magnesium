// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off - fixtures stand in for a machine server and its clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HUB_MACHINES_PATH, hubMachineAccessPath, type HubMachineList } from "@magnesium/contracts";
import {
  AuthAccessTokenType,
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { routesLayer } from "../index.ts";
import { CallerUnauthenticatedError, ServerPorts } from "../ports.ts";
import {
  authenticateTestSocket,
  defaultSettingsPorts,
  noThreads,
  testDescriptor,
} from "../testing.ts";
import * as HubMachines from "./HubMachines.ts";
import { parseProxyPath } from "./proxy.ts";
import { renewedScopes } from "../session/renew.ts";

const MACHINE_URL = "http://127.0.0.1:10001";
const ENVIRONMENT_ID = "env-cpu-host-1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A paired client's grant before granular permissions (T3 Code v0.0.45). */
const LEGACY_STANDARD_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as ReadonlyArray<AuthEnvironmentScope>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const descriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "cpu-host-1",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.45",
  capabilities: { repositoryIdentity: true },
};

const sessionState = (authenticated: boolean, scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  authenticated,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  ...(authenticated
    ? {
        scopes,
        sessionMethod: "bearer-access-token",
        expiresAt: new Date(Date.now() + 20 * DAY_MS).toISOString(),
      }
    : {}),
});

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A hub with one configured machine, `cpu-host-1`, whose server is faked over HttpClient. */
const makeHub = async (options: { readonly machineToken?: string } = {}) => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mg-hub-"));
  cleanups.push(() => NodeFSP.rm(baseDir, { recursive: true, force: true }));
  await NodeFSP.writeFile(
    NodePath.join(baseDir, HubMachines.HUB_MACHINES_CONFIG_FILE),
    JSON.stringify({ machines: [{ name: "cpu-host-1", url: MACHINE_URL }] }),
  );

  const secrets = new Map<string, Uint8Array>();
  const seen: SeenRequest[] = [];
  let validToken = options.machineToken ?? "machine-token";
  let renewCalls = 0;
  // Whether the machine renews the hub's token: in its last week, or a grant from before granular permissions.
  let machineRenews = false;
  const issuedScopes: Array<ReadonlyArray<AuthEnvironmentScope>> = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      seen.push({ method: request.method, url: request.url, headers: { ...request.headers } });
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json", ...headers },
          }),
        );
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      switch (url.pathname) {
        case "/.well-known/t3/environment":
          return json(descriptor);
        case "/api/auth/session":
          return json(
            sessionState(
              bearer === validToken || bearer === "admin-token",
              bearer === "admin-token" ? AuthAdministrativeScopes : AuthStandardClientScopes,
            ),
          );
        case "/oauth/token":
          return json({
            access_token: "paired-token",
            issued_token_type: AuthAccessTokenType,
            token_type: "Bearer",
            expires_in: 30 * 24 * 60 * 60,
            scope: AuthStandardClientScopes.join(" "),
          });
        case "/api/magnesium/session/renew":
          renewCalls++;
          if (!machineRenews)
            return json({ error: "This session is not due for renewal yet." }, 409);
          validToken = "renewed-token";
          return json({
            token: "renewed-token",
            expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
          });
        default:
          if (bearer !== validToken) return json({ error: "nope" }, 401);
          return json({ path: url.pathname, search: url.search }, 200, {
            "set-cookie": "t3_session=machine; Path=/",
          });
      }
    }),
  );

  const scopesFor: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
    admin: AuthAdministrativeScopes,
    operator: AuthStandardClientScopes,
    reader: [AuthOrchestrationReadScope],
    // Minted by the `t3` CLI (or an agent that can run it): every scope, but no paired device.
    cli: AuthAdministrativeScopes,
  };
  const ports = ServerPorts.of({
    baseDir,
    stateDir: baseDir,
    authenticateWebSocket: authenticateTestSocket,
    environment: Effect.succeed(testDescriptor()),
    threads: noThreads,
    authenticate: (request) => {
      const cookie = request.cookies.t3_session;
      if (cookie !== undefined && scopesFor[cookie] !== undefined) {
        return Effect.succeed({
          sessionId: `session-${cookie}`,
          subject: cookie,
          method: "browser-session-cookie" as ServerAuthSessionMethod,
          scopes: scopesFor[cookie],
          expiresAt: undefined,
          paired: cookie !== "cli",
        });
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (bearer === "due" || bearer === "not-due" || bearer === "legacy-not-due") {
        const days = bearer === "due" ? 3 : 20;
        return Effect.succeed({
          sessionId: `session-${bearer}`,
          subject: "hub",
          method: "bearer-access-token" as ServerAuthSessionMethod,
          scopes: bearer === "legacy-not-due" ? LEGACY_STANDARD_SCOPES : AuthStandardClientScopes,
          expiresAt: DateTime.makeUnsafe(Date.now() + days * DAY_MS),
          paired: true,
        });
      }
      return Effect.fail(new CallerUnauthenticatedError({ detail: "no session" }));
    },
    issueBearerSession: (input) =>
      Effect.sync(() => {
        issuedScopes.push(input.scopes);
        return {
          token: "fresh-session",
          expiresAt: DateTime.makeUnsafe(Date.now() + 30 * DAY_MS),
        };
      }),
    getSecret: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
    setSecret: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    removeSecret: (name) => Effect.sync(() => void secrets.delete(name)),
    ...defaultSettingsPorts,
  });

  const services = Layer.mergeAll(
    Layer.succeed(ServerPorts, ports),
    Layer.succeed(HttpClient.HttpClient, client),
    NodeServices.layer,
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    routesLayer.pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  cleanups.push(dispose);

  const request = (path: string, init: RequestInit & { session?: string } = {}) =>
    handler(
      new Request(`http://hub.test${path}`, {
        ...init,
        headers: {
          ...(init.session ? { cookie: `t3_session=${init.session}` } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
  const list = async (session = "operator") =>
    ((await (await request(HUB_MACHINES_PATH, { session })).json()) as HubMachineList).machines;
  const giveAccess = (body: unknown, session = "admin") =>
    request(hubMachineAccessPath("cpu-host-1"), {
      method: "PUT",
      session,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const machinesLayer = HubMachines.layer.pipe(Layer.provide(services));

  return {
    request,
    list,
    giveAccess,
    machinesLayer,
    seen,
    secrets,
    renewCalls: () => renewCalls,
    setMachineRenews: (renews: boolean) => {
      machineRenews = renews;
    },
    issuedScopes,
  };
};

describe("parseProxyPath", () => {
  it.each([
    ["/api/magnesium/env/cpu-host-1/ws", "/ws"],
    ["/api/magnesium/env/cpu-host-1/.well-known/t3/environment", "/.well-known/t3/environment"],
    ["/api/magnesium/env/cpu-host-1/api/orchestration/shell", "/api/orchestration/shell"],
    ["/api/magnesium/env/cpu-host-1/api/auth/session", "/api/auth/session"],
    ["/api/magnesium/env/cpu-host-1/api/assets/a/b.png", "/api/assets/a/b.png"],
  ])("carries %s", (pathname, path) => {
    expect(parseProxyPath(pathname)).toEqual({ name: "cpu-host-1", path });
  });

  it.each([
    "/api/magnesium/env/cpu-host-1/oauth/token",
    "/api/magnesium/env/cpu-host-1/api/auth/pairing-token",
    "/api/magnesium/env/cpu-host-1/api/auth/access/stream",
    "/api/magnesium/env/cpu-host-1/api/magnesium/session/renew",
    "/api/magnesium/env/cpu-host-1/",
    "/api/magnesium/env/cpu-host-1",
    "/api/magnesium/env//ws",
    "/api/magnesium/env/%E0%A4%A/ws",
  ])("refuses %s", (pathname) => {
    expect(parseProxyPath(pathname)).toBeNull();
  });
});

describe("hub machines", () => {
  it("lists a configured machine as needing access until the hub holds a token", async () => {
    const hub = await makeHub();
    expect(await hub.list()).toEqual([
      {
        name: "cpu-host-1",
        label: "cpu-host-1",
        environmentId: ENVIRONMENT_ID,
        access: "missing",
        accessExpiresAt: null,
        online: true,
      },
    ]);
    expect((await hub.request(HUB_MACHINES_PATH)).status).toBe(401);
  });

  it("takes a browser's token only from an admin session, and never hands it back", async () => {
    const hub = await makeHub();
    expect((await hub.giveAccess({ bearerToken: "machine-token" }, "operator")).status).toBe(403);
    const response = await hub.giveAccess({ bearerToken: "machine-token" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("machine-token");
    expect(JSON.parse(body)).toMatchObject({ name: "cpu-host-1", access: "ready" });
    expect(await hub.list()).toMatchObject([{ access: "ready" }]);
    const listed = await (await hub.request(HUB_MACHINES_PATH, { session: "operator" })).text();
    expect(listed).not.toContain("machine-token");
  });

  it("refuses tokens the machine does not accept, and admin tokens", async () => {
    const hub = await makeHub();
    expect((await hub.giveAccess({ bearerToken: "stale" })).status).toBe(422);
    expect((await hub.giveAccess({ bearerToken: "admin-token" })).status).toBe(422);
    expect((await hub.giveAccess({ nothing: true })).status).toBe(400);
    expect(await hub.list()).toMatchObject([{ access: "missing" }]);
  });

  it("pairs with a code minted on the machine", async () => {
    const hub = await makeHub({ machineToken: "paired-token" });
    const response = await hub.giveAccess({ pairingCode: "ABCDEF123456" });
    expect(response.status).toBe(200);
    expect(await hub.list()).toMatchObject([{ access: "ready" }]);
    const exchange = hub.seen.find((seen) => seen.url.endsWith("/oauth/token"));
    expect(exchange?.method).toBe("POST");
  });

  it("forgets access on request", async () => {
    const hub = await makeHub();
    await hub.giveAccess({ bearerToken: "machine-token" });
    const removed = await hub.request(hubMachineAccessPath("cpu-host-1"), {
      method: "DELETE",
      session: "admin",
    });
    expect(removed.status).toBe(204);
    expect(await hub.list()).toMatchObject([{ access: "missing" }]);
    expect(hub.secrets.size).toBe(0);
  });

  it.live("renews a token in its last week, and leaves a fresh one alone", () =>
    Effect.gen(function* () {
      const hub = yield* Effect.promise(() => makeHub());
      yield* Effect.promise(() => hub.giveAccess({ bearerToken: "machine-token" }));
      const renewDue = Effect.flatMap(HubMachines.HubMachines, (machines) => machines.renewDue);
      // A fresh token is offered once, in case the machine renews its grant early; it does not.
      // (The hub's own renewal loop may offer it too, so only this instance's calls are counted.)
      yield* Effect.gen(function* () {
        yield* renewDue;
        const offered = hub.renewCalls();
        yield* renewDue;
        expect(hub.renewCalls()).toBe(offered);
      }).pipe(Effect.provide(hub.machinesLayer));
      expect(JSON.parse(new TextDecoder().decode([...hub.secrets.values()][0]!)).token).toBe(
        "machine-token",
      );

      const [name, bytes] = [...hub.secrets.entries()][0]!;
      const stored = JSON.parse(new TextDecoder().decode(bytes));
      const soon = new Date(Date.now() + 3 * DAY_MS).toISOString();
      hub.secrets.set(
        name,
        new TextEncoder().encode(JSON.stringify({ ...stored, expiresAt: soon })),
      );
      hub.setMachineRenews(true);
      yield* renewDue.pipe(Effect.provide(hub.machinesLayer));
      const renewed = JSON.parse(new TextDecoder().decode(hub.secrets.get(name)!));
      expect(renewed.token).toBe("renewed-token");
    }),
  );
});

describe("hub proxy", () => {
  it("swaps the hub session for the machine's token and keeps the machine's cookies off the hub", async () => {
    const hub = await makeHub();
    await hub.giveAccess({ bearerToken: "machine-token" });
    const response = await hub.request(
      "/api/magnesium/env/cpu-host-1/api/orchestration/shell?after=3",
      { session: "operator", headers: { origin: "http://hub.test", "x-trace": "1" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/api/orchestration/shell", search: "?after=3" });
    expect(response.headers.get("set-cookie")).toBeNull();
    const forwarded = hub.seen.at(-1)!;
    expect(forwarded.url).toBe(`${MACHINE_URL}/api/orchestration/shell?after=3`);
    expect(forwarded.headers.authorization).toBe("Bearer machine-token");
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(forwarded.headers.origin).toBeUndefined();
    expect(forwarded.headers["x-trace"]).toBe("1");
  });

  it("needs a hub session, and operate scope to change anything", async () => {
    const hub = await makeHub();
    await hub.giveAccess({ bearerToken: "machine-token" });
    const path = "/api/magnesium/env/cpu-host-1/api/orchestration/threads";
    expect((await hub.request(path)).status).toBe(401);
    expect((await hub.request(path, { session: "reader", method: "POST" })).status).toBe(403);
    expect((await hub.request(path, { session: "reader" })).status).toBe(200);
  });

  it("takes only paired devices: a CLI-minted session never reaches a machine", async () => {
    const hub = await makeHub();
    await hub.giveAccess({ bearerToken: "machine-token" });
    const path = "/api/magnesium/env/cpu-host-1/api/orchestration/shell";
    expect((await hub.request(path, { session: "cli" })).status).toBe(403);
    expect((await hub.request(HUB_MACHINES_PATH, { session: "cli" })).status).toBe(403);
    expect((await hub.giveAccess({ pairingCode: "code" }, "cli")).status).toBe(403);
    const removed = await hub.request(hubMachineAccessPath("cpu-host-1"), {
      method: "DELETE",
      session: "cli",
    });
    expect(removed.status).toBe(403);
    expect((await hub.list()).map((machine) => machine.access)).toEqual(["ready"]);
  });

  it("refuses unknown machines, machines without access, and pairing routes", async () => {
    const hub = await makeHub();
    expect(
      (
        await hub.request("/api/magnesium/env/cpu-host-1/api/orchestration/shell", {
          session: "operator",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await hub.request("/api/magnesium/env/nope/api/orchestration/shell", {
          session: "operator",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await hub.request("/api/magnesium/env/cpu-host-1/oauth/token", {
          session: "operator",
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  it("shows the machine as expired once it refuses the hub's token", async () => {
    const hub = await makeHub();
    await hub.giveAccess({ bearerToken: "machine-token" });
    const [name, bytes] = [...hub.secrets.entries()][0]!;
    const stored = JSON.parse(new TextDecoder().decode(bytes));
    hub.secrets.set(
      name,
      new TextEncoder().encode(JSON.stringify({ ...stored, token: "revoked" })),
    );
    const response = await hub.request("/api/magnesium/env/cpu-host-1/api/orchestration/shell", {
      session: "operator",
    });
    expect(response.status).toBe(401);
    expect(await hub.list()).toMatchObject([{ access: "expired" }]);
  });
});

describe("session renewal", () => {
  it("renews a grant from before granular permissions as what its broad scopes implied", () => {
    const renewed = renewedScopes(LEGACY_STANDARD_SCOPES);
    for (const scope of [
      "orchestration:read",
      "orchestration:operate",
      "settings:write",
      "providers:manage",
      "filesystem:read",
      "terminal:read",
      "terminal:operate",
      "relay:read",
    ] as const) {
      expect(renewed).toContain(scope);
    }
    // Nothing the old grant did not hold, and the retired scope goes.
    expect(renewed).not.toContain("access:write");
    expect(renewed).not.toContain("review:write");
    // A current grant renews as it is.
    expect(renewedScopes(AuthStandardClientScopes)).toEqual(AuthStandardClientScopes);
  });

  it("swaps a bearer session in its last week for a new one", async () => {
    const hub = await makeHub();
    const due = await hub.request("/api/magnesium/session/renew", {
      method: "POST",
      headers: { authorization: "Bearer due" },
    });
    expect(due.status).toBe(200);
    expect(await due.json()).toMatchObject({ token: "fresh-session" });
    const early = await hub.request("/api/magnesium/session/renew", {
      method: "POST",
      headers: { authorization: "Bearer not-due" },
    });
    expect(early.status).toBe(409);
    // A grant from before granular permissions renews early, as what it meant then.
    const legacy = await hub.request("/api/magnesium/session/renew", {
      method: "POST",
      headers: { authorization: "Bearer legacy-not-due" },
    });
    expect(legacy.status).toBe(200);
    expect(hub.issuedScopes.at(-1)).toEqual(renewedScopes(LEGACY_STANDARD_SCOPES));
    const cookie = await hub.request("/api/magnesium/session/renew", {
      method: "POST",
      session: "admin",
    });
    expect(cookie.status).toBe(403);
  });
});
