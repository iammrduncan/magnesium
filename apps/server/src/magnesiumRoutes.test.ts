// magnesium: how Magnesium's routes see each kind of credential, through upstream's real auth (goal 04)
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes, AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { callerAuthentication, registerPairingCode } from "./magnesiumRoutes.ts";
import * as AuthPairingLinks from "./persistence/AuthPairingLinks.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return {
          ...config,
          mode: "web" as const,
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make(DEV_TOKEN),
        };
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mg-callers-test-" }))),
  ),
);

const request = (input: {
  readonly bearer?: string;
  readonly cookies?: Record<string, string>;
  readonly url?: string;
}) =>
  ({
    url: input.url ?? "/api/magnesium/hub/machines",
    cookies: input.cookies ?? {},
    headers: input.bearer === undefined ? {} : { authorization: `Bearer ${input.bearer}` },
  }) as unknown as HttpServerRequest.HttpServerRequest;

const metadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

it.layer(NodeServices.layer)("Magnesium's callers", (it) => {
  it.effect("an agent's /mcp credential is not a session at all", () =>
    Effect.gen(function* () {
      const callers = callerAuthentication(yield* EnvironmentAuth.EnvironmentAuth);
      // The same shape McpSessionRegistry mints: 32 random bytes, base64url, unsigned.
      const mcpToken = NodeCrypto.randomBytes(32).toString("base64url");
      const http = yield* callers.http(request({ bearer: mcpToken })).pipe(Effect.flip);
      expect(http._tag).toBe("CallerUnauthenticatedError");
      const socket = yield* callers.webSocket(request({ bearer: mcpToken })).pipe(Effect.flip);
      expect(socket._tag).toBe("CallerUnauthenticatedError");
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("sessions the CLI mints and the dev token are not paired devices", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const callers = callerAuthentication(auth);
      // What `t3 auth session issue` does: every scope, no device.
      const cliIssued = yield* auth.issueSession();
      const cli = yield* callers.http(request({ bearer: cliIssued.token }));
      expect(cli.scopes).toEqual(AuthAdministrativeScopes);
      expect(cli.paired).toBe(false);
      // Agents inherit T3CODE_DEV_AUTH_TOKEN in web dev mode.
      const dev = yield* callers.http(request({ bearer: DEV_TOKEN }));
      expect(dev.paired).toBe(false);
    }).pipe(Effect.provide(authLayer)),
  );

  it.effect("a paired browser, a paired bearer client and its WebSocket tickets are", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const callers = callerAuthentication(auth);

      const forBrowser = yield* auth.issuePairingCredential();
      const browser = yield* auth.createBrowserSession(forBrowser.credential, metadata);
      const cookie = yield* callers.http(
        request({ cookies: { [sessions.cookieName]: browser.sessionToken } }),
      );
      expect(cookie).toMatchObject({ method: "browser-session-cookie", paired: true });

      // How the hub gets its token for a machine: a pairing code traded for a bearer token.
      const forHub = yield* auth.issuePairingCredential();
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        forHub.credential,
        undefined,
        { ...metadata, deviceType: "bot" },
      );
      const bearer = yield* callers.http(request({ bearer: token.access_token }));
      expect(bearer).toMatchObject({ method: "bearer-access-token", paired: true });

      const ticket = yield* auth.issueWebSocketTicket({
        sessionId: AuthSessionId.make(bearer.sessionId),
      });
      const socket = yield* callers.webSocket(
        request({ url: `/api/magnesium/ws?wsTicket=${ticket.ticket}` }),
      );
      expect(socket.paired).toBe(true);
    }).pipe(Effect.provide(authLayer)),
  );
  it.effect(
    "a pairing code from the environment pairs the hub once, and a restart never re-arms it",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const callers = callerAuthentication(auth);
        const pairingLinks = yield* AuthPairingLinks.AuthPairingLinkRepository;
        const crypto = yield* Crypto.Crypto;
        const code = "GATEWAY-BOOTSTRAP-0123456789";
        const input = {
          code,
          label: "Magnesium hub",
          expiresAt: DateTime.add(yield* DateTime.now, { days: 7 }),
        };

        expect(yield* registerPairingCode(pairingLinks, crypto, input)).toBe(true);
        // The server restarts with the same Secret before the hub pairs: nothing changes.
        expect(yield* registerPairingCode(pairingLinks, crypto, input)).toBe(false);

        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(code, undefined, {
          ...metadata,
          deviceType: "bot",
        });
        const hub = yield* callers.http(request({ bearer: token.access_token }));
        expect(hub).toMatchObject({ method: "bearer-access-token", paired: true });

        // Spent: it can't pair anyone again, even after another restart.
        const again = yield* auth
          .exchangeBootstrapCredentialForAccessToken(code, undefined, metadata)
          .pipe(Effect.flip);
        expect(again._tag).toBe("ServerAuthInvalidCredentialError");
        expect(yield* registerPairingCode(pairingLinks, crypto, input)).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(authLayer, AuthPairingLinks.layer.pipe(Layer.provide(authLayer))),
        ),
      ),
  );
});
