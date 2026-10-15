import { isCacheableResponse, isFrontDoorFailure, requestStrategy, SHELL_PATH } from "./policy.ts";

/** Every cache the shell worker owns starts with this; other caches are left alone. */
export const SHELL_CACHE_PREFIX = "magnesium-shell-";

/** The parts of the Cache Storage API the worker uses. */
export interface ShellCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface ShellCacheStorage {
  open(name: string): Promise<ShellCache>;
  keys(): Promise<ReadonlyArray<string>>;
  delete(name: string): Promise<boolean>;
}

export interface ShellWorkerOptions {
  /** Changes with every build, so each build gets its own cache. */
  readonly version: string;
  /** Paths to store at install (`shellPrecacheList`). */
  readonly precache: ReadonlyArray<string>;
  /** The build's entry script; the shell fetched at install must load it. */
  readonly entry: string;
  readonly origin: string;
  readonly caches: ShellCacheStorage;
  readonly fetch: (request: Request) => Promise<Response>;
}

/**
 * The service worker's behaviour, apart from its event wiring (`sw.ts`).
 *
 * - `install` stores the shell for this build, and fails if the server has
 *   already moved on to another build, so the browser retries with the new
 *   worker instead of keeping a shell whose code is gone.
 * - `activate` deletes the caches of earlier builds.
 * - `respond` answers a request, or returns `undefined` to leave it to the
 *   browser. `waitUntil` keeps the worker alive while a response is stored.
 */
export function makeShellWorker(options: ShellWorkerOptions) {
  const cacheName = `${SHELL_CACHE_PREFIX}${options.version}`;
  const scope = { origin: options.origin, precached: new Set(options.precache) };
  const shellRequest = () => new Request(new URL(SHELL_PATH, options.origin));

  const install = async () => {
    const cache = await options.caches.open(cacheName);
    await Promise.all(
      options.precache.map(async (path) => {
        const request = new Request(new URL(path, options.origin));
        const response = await options.fetch(request);
        if (!isCacheableResponse(path, response)) {
          throw new Error(`The shell worker can't store ${path} (HTTP ${response.status}).`);
        }
        if (path === SHELL_PATH && !(await response.clone().text()).includes(options.entry)) {
          throw new Error("The server has a newer build than this shell worker.");
        }
        await cache.put(request, response);
      }),
    );
  };

  const activate = async () => {
    const names = await options.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== cacheName)
        .map((name) => options.caches.delete(name)),
    );
  };

  const cachedShell = async () => (await options.caches.open(cacheName)).match(shellRequest());

  const navigate = async (request: Request) => {
    let response: Response;
    try {
      response = await options.fetch(request);
    } catch (error) {
      const shell = await cachedShell();
      if (shell === undefined) throw error;
      return shell;
    }
    if (!isFrontDoorFailure(response.status)) return response;
    return (await cachedShell()) ?? response;
  };

  const cacheFirst = async (request: Request, waitUntil: (promise: Promise<unknown>) => void) => {
    const cache = await options.caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
    const response = await options.fetch(request);
    if (isCacheableResponse(new URL(request.url).pathname, response)) {
      waitUntil(cache.put(request, response.clone()));
    }
    return response;
  };

  const respond = (
    request: Request,
    waitUntil: (promise: Promise<unknown>) => void,
  ): Promise<Response> | undefined => {
    switch (requestStrategy(request, scope)) {
      case "navigate":
        return navigate(request);
      case "cache-first":
        return cacheFirst(request, waitUntil);
      case "passthrough":
        return undefined;
    }
  };

  return { cacheName, install, activate, respond };
}
