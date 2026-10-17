// @effect-diagnostics globalFetchInEffect:off - the test calls the gateway as the hub's HTTP client would.
import {
  type FleetMachine,
  type FleetMachinesItem,
  fleetMachineKey,
  MAGNESIUM_WS_METHODS,
} from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { urlUnder } from "../forward.ts";
import { HUB_MACHINES_CONFIG_FILE } from "../hub/HubMachines.ts";
import { connect } from "../rpc/client.ts";
import {
  startTestServer,
  testDescriptor,
  testHubConfig,
  testHubSecrets,
  testTicketRoute,
} from "../testing.ts";
import { gatewayConfigFromEnv, gatewayRouteLayer, parseSpokePath } from "./gateway.ts";

describe("the gateway's paths", () => {
  it("takes a spoke's name and its own path, and nothing that could aim elsewhere", () => {
    expect(parseSpokePath("/spokes/cpu-host-2/ws")).toEqual({ name: "cpu-host-2", path: "/ws" });
    expect(parseSpokePath("/spokes/cpu-host-2/api/auth/session")).toEqual({
      name: "cpu-host-2",
      path: "/api/auth/session",
    });
    expect(parseSpokePath("/spokes/cpu-host-2")).toEqual({ name: "cpu-host-2", path: "/" });
    expect(parseSpokePath("/spokes/../etc/passwd")).toBeNull();
    expect(parseSpokePath("/spokes/evil.example.com/ws")).toBeNull();
    expect(parseSpokePath("/spokes/a%2Fb/ws")).toBeNull();
    expect(parseSpokePath("/spokes/UPPER/ws")).toBeNull();
    expect(parseSpokePath("/ws")).toBeNull();
  });

  it("joins a path under a base that has one, and under one that doesn't", () => {
    expect(urlUnder("https://gateway.example/spokes/cpu-host-2", "/ws?wsTicket=t").toString()).toBe(
      "https://gateway.example/spokes/cpu-host-2/ws?wsTicket=t",
    );
    expect(urlUnder("https://gateway.example/spokes/cpu-host-2/", "/ws").toString()).toBe(
      "https://gateway.example/spokes/cpu-host-2/ws",
    );
    expect(urlUnder("http://127.0.0.1:13704", "/api/magnesium/ws").toString()).toBe(
      "http://127.0.0.1:13704/api/magnesium/ws",
    );
  });

  it("is a gateway only when the role says so, reaching each spoke's Service by default", () => {
    expect(gatewayConfigFromEnv({})).toBeNull();
    expect(gatewayConfigFromEnv({ MAGNESIUM_ROLE: "machine" })).toBeNull();
    expect(gatewayConfigFromEnv({ MAGNESIUM_ROLE: "gateway" })?.spokeOrigin("cpu-host-2")).toBe(
      "http://magnesium-cpu-host-2:3773",
    );
    expect(
      gatewayConfigFromEnv({
        MAGNESIUM_ROLE: "gateway",
        MAGNESIUM_SPOKE_URL: "http://spoke-{name}.ns.svc:3773",
      })?.spokeOrigin("x"),
    ).toBe("http://spoke-x.ns.svc:3773");
  });
});

describe("the hub through a gateway", () => {
  it.live("reaches a spoke as at its own address: HTTP, its token checks and the live link", () =>
    Effect.gen(function* () {
      const descriptorOfSpoke = testDescriptor({
        environmentId: EnvironmentId.make("env-cpu-host-2"),
      });
      const spoke = yield* startTestServer({
        routes: Layer.mergeAll(
          testTicketRoute("machine-token"),
          // Upstream's descriptor route, which the full server serves.
          HttpRouter.add(
            "GET",
            "/.well-known/t3/environment",
            Effect.succeed(HttpServerResponse.jsonUnsafe(descriptorOfSpoke)),
          ),
          // What a body looks like when it arrives, as pairing's form POST needs it.
          HttpRouter.add(
            "POST",
            "/echo",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
              return HttpServerResponse.jsonUnsafe({
                contentType: request.headers["content-type"] ?? null,
                body,
              });
            }),
          ),
        ),
        ports: { environment: Effect.succeed(descriptorOfSpoke) },
      });
      const gateway = yield* startTestServer({
        routes: gatewayRouteLayer({
          spokeOrigin: (name) => (name === "cpu-host-2" ? spoke.origin : "http://127.0.0.1:9"),
          image: (build) => `magnesium:${build}`,
          storageClass: null,
        }).pipe(HttpRouter.provideRequest(FetchHttpClient.layer)),
      });

      // HTTP passes through, with the hub's token for the spoke and nothing else.
      const descriptor = yield* Effect.promise(() =>
        fetch(`${gateway.origin}/spokes/cpu-host-2/.well-known/t3/environment`).then((response) =>
          response.json(),
        ),
      );
      expect(descriptor).toMatchObject({ environmentId: "env-cpu-host-2" });
      const ticket = (authorization?: string) =>
        Effect.promise(() =>
          fetch(`${gateway.origin}/spokes/cpu-host-2/api/auth/websocket-ticket`, {
            method: "POST",
            headers: authorization ? { authorization } : {},
          }).then((response) => response.status),
        );
      expect(yield* ticket("Bearer machine-token")).toBe(200);
      // A body keeps its content type through the gateway: pairing posts a form.
      const echoed = yield* Effect.promise(() =>
        fetch(`${gateway.origin}/spokes/cpu-host-2/echo`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=token-exchange&subject_token=CODE",
        }).then((response) => response.json()),
      );
      expect(echoed).toEqual({
        contentType: "application/x-www-form-urlencoded",
        body: "grant_type=token-exchange&subject_token=CODE",
      });
      expect(yield* ticket("Bearer someone-else")).toBe(401);
      expect(yield* ticket()).toBe(401);

      // A spoke that doesn't answer, and a name that isn't one.
      const status = (path: string) =>
        Effect.promise(() => fetch(`${gateway.origin}${path}`).then((response) => response.status));
      expect(yield* status("/spokes/cpu-host-9/.well-known/t3/environment")).toBe(502);
      expect(yield* status("/spokes/Not.A.Name/ws")).toBe(404);

      // The hub's live link to the spoke runs through the gateway: Fleet shows it connected.
      const hub = yield* startTestServer({
        files: {
          [HUB_MACHINES_CONFIG_FILE]: testHubConfig({
            "cpu-host-2": `${gateway.origin}/spokes/cpu-host-2`,
          }),
        },
        ports: {
          getSecret: testHubSecrets({ "cpu-host-2": "machine-token" }),
          environment: Effect.succeed(
            testDescriptor({ environmentId: EnvironmentId.make("env-hub"), label: "hub" }),
          ),
        },
      });
      const browser = yield* connect(hub.wsUrl("operator"));
      const rows = new Map<string, FleetMachine>();
      const changed = yield* Queue.unbounded<void>();
      yield* Effect.forkScoped(
        browser[MAGNESIUM_WS_METHODS.fleetMachines]({}).pipe(
          Stream.runForEach((item: FleetMachinesItem) =>
            Effect.sync(() => {
              const upserts = item._tag === "snapshot" ? item.rows : item.upserts;
              for (const row of upserts) rows.set(fleetMachineKey(row), row);
            }).pipe(Effect.andThen(Queue.offer(changed, undefined))),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        while (rows.get("cpu-host-2")?.link !== "connected") yield* Queue.take(changed);
      }).pipe(Effect.timeout("10 seconds"));
      expect(rows.get("cpu-host-2")).toMatchObject({
        link: "connected",
        environmentId: "env-cpu-host-2",
      });
    }),
  );
});
