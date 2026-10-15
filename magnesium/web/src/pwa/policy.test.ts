import { describe, expect, it } from "@effect/vitest";

import {
  isCacheableResponse,
  isFrontDoorFailure,
  requestStrategy,
  type RequestFacts,
  shellPrecacheList,
} from "./policy.ts";

const ORIGIN = "https://hub.example.test";
const scope = {
  origin: ORIGIN,
  precached: new Set(["/", "/icon-192.png", "/manifest.webmanifest"]),
};

const request = (path: string, overrides: Partial<RequestFacts> = {}): RequestFacts => ({
  url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
  method: "GET",
  mode: "cors",
  headers: new Headers(),
  ...overrides,
});
const navigation = (path: string) => request(path, { mode: "navigate" });

const response = (
  init: {
    status?: number;
    type?: string;
    redirected?: boolean;
    headers?: Record<string, string>;
  } = {},
) => ({
  status: init.status ?? 200,
  type: init.type ?? "basic",
  redirected: init.redirected ?? false,
  headers: new Headers(init.headers ?? { "content-type": "text/javascript" }),
});

describe("requestStrategy", () => {
  it("loads pages network first, whatever the app route", () => {
    expect(requestStrategy(navigation("/"), scope)).toBe("navigate");
    expect(requestStrategy(navigation("/env-1/thread-1"), scope)).toBe("navigate");
    expect(requestStrategy(navigation("/settings/connections"), scope)).toBe("navigate");
  });

  it("never answers for the server's own paths, pages or not", () => {
    for (const path of [
      "/api/auth/session",
      "/api/magnesium/ws",
      "/api/magnesium/env/cpu-host-1/api/orchestration/shell",
      "/api/magnesium/env/cpu-host-1/ws",
      "/ws",
      "/.well-known/t3/environment",
      "/oauth/callback?code=x",
      "/mcp",
    ]) {
      expect(requestStrategy(request(path), scope), path).toBe("passthrough");
      expect(requestStrategy(navigation(path), scope), path).toBe("passthrough");
    }
  });

  it("leaves pairing links to the network so an offline shell never spends their token", () => {
    expect(requestStrategy(navigation("/pair"), scope)).toBe("passthrough");
    expect(requestStrategy(navigation("/?token=one-time"), scope)).toBe("passthrough");
  });

  it("serves build assets and precached shell files from the cache", () => {
    expect(requestStrategy(request("/assets/index-AbCd0123.js"), scope)).toBe("cache-first");
    expect(requestStrategy(request("/assets/main-AbCd0123.css"), scope)).toBe("cache-first");
    expect(requestStrategy(request("/icon-192.png"), scope)).toBe("cache-first");
    expect(requestStrategy(request("/manifest.webmanifest"), scope)).toBe("cache-first");
  });

  it("stays out of writes, other origins, byte ranges and unlisted files", () => {
    expect(requestStrategy(request("/assets/a-AbCd0123.js", { method: "POST" }), scope)).toBe(
      "passthrough",
    );
    expect(requestStrategy(request("https://cdn.example.test/assets/a.js"), scope)).toBe(
      "passthrough",
    );
    expect(
      requestStrategy(
        request("/assets/sound-AbCd0123.mp3", { headers: new Headers({ range: "bytes=0-" }) }),
        scope,
      ),
    ).toBe("passthrough");
    expect(requestStrategy(request("/third-party-licenses.json"), scope)).toBe("passthrough");
  });
});

describe("isCacheableResponse", () => {
  it("keeps a good asset and an HTML shell", () => {
    expect(isCacheableResponse("/assets/a-AbCd0123.js", response())).toBe(true);
    expect(
      isCacheableResponse(
        "/",
        response({ headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    ).toBe(true);
  });

  it("refuses the index.html the server sends for a missing asset", () => {
    expect(
      isCacheableResponse(
        "/assets/gone-AbCd0123.js",
        response({ headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    ).toBe(false);
    expect(isCacheableResponse("/", response())).toBe(false);
  });

  it("refuses failures, redirects, opaque answers, cookies and no-store", () => {
    const path = "/assets/a-AbCd0123.js";
    expect(isCacheableResponse(path, response({ status: 404 }))).toBe(false);
    expect(isCacheableResponse(path, response({ redirected: true }))).toBe(false);
    expect(isCacheableResponse(path, response({ type: "opaque" }))).toBe(false);
    expect(
      isCacheableResponse(
        path,
        response({ headers: { "content-type": "text/javascript", "set-cookie": "t3_session=x" } }),
      ),
    ).toBe(false);
    expect(
      isCacheableResponse(
        path,
        response({
          headers: { "content-type": "text/javascript", "cache-control": "private, no-store" },
        }),
      ),
    ).toBe(false);
  });
});

describe("isFrontDoorFailure", () => {
  it("is a gateway answer, not the server's own", () => {
    expect([502, 503, 504].every(isFrontDoorFailure)).toBe(true);
    expect([200, 401, 404, 500].some(isFrontDoorFailure)).toBe(false);
  });
});

describe("shellPrecacheList", () => {
  it("takes the shell, root icons and the code the app boots with, not route chunks", () => {
    const manifest = {
      "index.html": { file: "assets/index-a.js", isEntry: true, dynamicImports: ["src/main.tsx"] },
      "src/main.tsx": {
        file: "assets/main-b.js",
        imports: ["_utils.js"],
        dynamicImports: ["src/routes/settings.tsx"],
        css: ["assets/main-c.css"],
      },
      "_utils.js": { file: "assets/utils-d.js", imports: ["src/main.tsx"] },
      "src/routes/settings.tsx": { file: "assets/settings-e.js", imports: ["_utils.js"] },
    };
    expect(
      shellPrecacheList(manifest, [
        "index.html",
        "manifest.webmanifest",
        "icon-192.png",
        "favicon.ico",
        "third-party-licenses.json",
      ]),
    ).toEqual([
      "/",
      "/favicon.ico",
      "/icon-192.png",
      "/manifest.webmanifest",
      "/assets/index-a.js",
      "/assets/main-b.js",
      "/assets/main-c.css",
      "/assets/utils-d.js",
    ]);
  });
});
