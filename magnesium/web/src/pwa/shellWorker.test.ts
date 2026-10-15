import { describe, expect, it } from "@effect/vitest";

import {
  makeShellWorker,
  SHELL_CACHE_PREFIX,
  type ShellCache,
  type ShellCacheStorage,
} from "./shellWorker.ts";

const ORIGIN = "https://hub.example.test";
const ENTRY = "/assets/index-AbCd0123.js";
const SHELL_HTML = `<!doctype html><script type="module" src="${ENTRY}"></script>`;

class FakeCache implements ShellCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request) {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, response);
  }
}

class FakeCacheStorage implements ShellCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string) {
    const cache = this.caches.get(name) ?? new FakeCache();
    this.caches.set(name, cache);
    return cache;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const script = (body: string) =>
  new Response(body, { headers: { "content-type": "text/javascript" } });

/** A server: each path answers from `routes`; `down` makes every request fail like a dead network. */
function makeServer(routes: Routes) {
  const state = { down: false, requests: [] as Array<string> };
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    state.requests.push(url.pathname + url.search);
    if (state.down) throw new TypeError("Failed to fetch");
    return routes[url.pathname]?.() ?? html(SHELL_HTML);
  };
  return { state, fetch };
}

type Routes = Record<string, () => Response>;

const defaultRoutes = (): Routes => ({
  "/": () => html(SHELL_HTML),
  [ENTRY]: () => script("boot()"),
  "/icon-192.png": () => new Response("png", { headers: { "content-type": "image/png" } }),
  "/api/auth/session": () =>
    new Response('{"authenticated":true}', { headers: { "content-type": "application/json" } }),
});

function setup(routes = defaultRoutes()) {
  const caches = new FakeCacheStorage();
  const server = makeServer(routes);
  const worker = makeShellWorker({
    version: "build-2",
    precache: ["/", "/icon-192.png", ENTRY],
    entry: ENTRY,
    origin: ORIGIN,
    caches,
    fetch: server.fetch,
  });
  const pending: Array<Promise<unknown>> = [];
  const respond = (request: Request) => worker.respond(request, (promise) => pending.push(promise));
  return { caches, server, worker, respond, pending };
}

const get = (path: string) => new Request(`${ORIGIN}${path}`);

/** A page load. Node's Request can't be built with mode "navigate", so it is set on the instance. */
const page = (path: string) =>
  Object.defineProperty(new Request(`${ORIGIN}${path}`), "mode", { value: "navigate" });

describe("makeShellWorker", () => {
  it("stores the shell, icons and boot code in this build's cache at install", async () => {
    const { caches, worker } = setup();
    await worker.install();
    const cache = caches.caches.get(`${SHELL_CACHE_PREFIX}build-2`);
    expect([...(cache?.entries.keys() ?? [])].toSorted()).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}${ENTRY}`,
      `${ORIGIN}/icon-192.png`,
    ]);
  });

  it("fails to install when the server has moved on to another build", async () => {
    const moved = setup({
      ...defaultRoutes(),
      "/": () => html("<script src=/assets/index-New.js>"),
    });
    await expect(moved.worker.install()).rejects.toThrow("newer build");
    // The server answers a missing asset with index.html.
    const gone = setup({ ...defaultRoutes(), [ENTRY]: () => html(SHELL_HTML) });
    await expect(gone.worker.install()).rejects.toThrow(ENTRY);
  });

  it("deletes earlier builds' caches on activate and leaves other caches alone", async () => {
    const { caches, worker } = setup();
    await caches.open(`${SHELL_CACHE_PREFIX}build-1`);
    await caches.open("someone-else");
    await worker.install();
    await worker.activate();
    expect((await caches.keys()).toSorted()).toEqual([
      `${SHELL_CACHE_PREFIX}build-2`,
      "someone-else",
    ]);
  });

  it("loads pages from the network while it answers", async () => {
    const { worker, server, respond } = setup({
      ...defaultRoutes(),
      "/settings": () => html("fresh"),
    });
    await worker.install();
    const answer = await respond(page("/settings"));
    expect(await answer?.text()).toBe("fresh");
    expect(server.state.requests.at(-1)).toBe("/settings");
  });

  it("falls back to the cached shell when the network fails", async () => {
    const { worker, server, respond } = setup();
    await worker.install();
    server.state.down = true;
    const answer = await respond(page("/env-1/thread-1"));
    expect(await answer?.text()).toBe(SHELL_HTML);
  });

  it("falls back to the cached shell when the front door says the server is down", async () => {
    const { worker, respond } = setup({
      ...defaultRoutes(),
      "/fleet": () => html("Bad Gateway", 502),
      "/missing": () => html("Not Found", 404),
    });
    await worker.install();
    const answer = await respond(page("/fleet"));
    expect(await answer?.text()).toBe(SHELL_HTML);
    const notFound = await respond(page("/missing"));
    expect(notFound?.status).toBe(404);
  });

  it("still fails a page load offline when nothing was cached yet", async () => {
    const { server, respond } = setup();
    server.state.down = true;
    await expect(respond(page("/"))).rejects.toThrow("Failed to fetch");
  });

  it("leaves pairing pages and the server's routes to the browser, even offline", async () => {
    const { worker, server, respond } = setup();
    await worker.install();
    server.state.down = true;
    const before = server.state.requests.length;
    expect(respond(page("/pair"))).toBeUndefined();
    expect(respond(get("/api/auth/session"))).toBeUndefined();
    expect(respond(get("/api/magnesium/env/cpu-host-1/api/auth/session"))).toBeUndefined();
    expect(respond(page("/oauth/callback?code=once"))).toBeUndefined();
    expect(server.state.requests.length).toBe(before);
  });

  it("stores a build asset the first time it loads and serves it from the cache after", async () => {
    const chunk = "/assets/settings-AbCd0123.js";
    const { worker, server, respond, pending } = setup({
      ...defaultRoutes(),
      [chunk]: () => script("settings()"),
    });
    await worker.install();
    const first = await respond(get(chunk));
    expect(await first?.text()).toBe("settings()");
    await Promise.all(pending);
    server.state.down = true;
    const second = await respond(get(chunk));
    expect(await second?.text()).toBe("settings()");
  });

  it("never stores the index.html the server sends for an asset that is gone", async () => {
    const { worker, caches, respond, pending } = setup();
    await worker.install();
    const gone = "/assets/old-AbCd0123.js";
    const answer = await respond(get(gone));
    expect(answer?.headers.get("content-type")).toContain("text/html");
    await Promise.all(pending);
    expect(caches.caches.get(worker.cacheName)?.entries.has(`${ORIGIN}${gone}`)).toBe(false);
  });
});
