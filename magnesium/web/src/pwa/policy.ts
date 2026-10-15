import { isDevProxiedPath } from "@t3tools/shared/devProxy";

/**
 * What the shell service worker does with each request (goal 05). It caches
 * the app shell only: `index.html`, the hashed build assets, the icons and
 * the manifest. Everything the server answers itself goes straight to the
 * network, untouched.
 *
 * - `navigate`: a page load. Network first; the cached shell only when the
 *   network or the front door fails.
 * - `cache-first`: a hashed build asset or a precached shell file.
 * - `passthrough`: the worker stays out of the way.
 */
export type RequestStrategy = "navigate" | "cache-first" | "passthrough";

export interface RequestFacts {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly headers: { has(name: string): boolean };
}

/** The key the cached shell, `index.html`, is stored under. */
export const SHELL_PATH = "/";

/** Paths only the server answers: `/api` (the hub's machines too), `/ws`, `/oauth`, `/.well-known`, `/mcp`. */
export function isServerPath(pathname: string): boolean {
  return isDevProxiedPath(pathname) || pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export function requestStrategy(
  request: RequestFacts,
  scope: { readonly origin: string; readonly precached: ReadonlySet<string> },
): RequestStrategy {
  if (request.method !== "GET") return "passthrough";
  const url = new URL(request.url);
  if (url.origin !== scope.origin || isServerPath(url.pathname)) return "passthrough";
  if (request.mode === "navigate") {
    // A pairing link carries a one-time token the app spends at boot. From a
    // cached shell while offline, it would be spent on nothing, so pairing
    // pages always come from the network.
    return url.pathname === "/pair" || url.searchParams.has("token") ? "passthrough" : "navigate";
  }
  // Media elements ask for byte ranges, which a whole cached file can't answer.
  if (request.headers.has("range")) return "passthrough";
  if (url.pathname.startsWith("/assets/") || scope.precached.has(url.pathname)) {
    return "cache-first";
  }
  return "passthrough";
}

export interface ResponseFacts {
  readonly status: number;
  readonly type: string;
  readonly redirected: boolean;
  readonly headers: { get(name: string): string | null; has(name: string): boolean };
}

/**
 * Whether a response may be stored under `pathname`. The shell must be HTML;
 * any other file must not be, because the server answers a missing file with
 * `index.html`. Responses that set cookies or forbid storing are never kept.
 */
export function isCacheableResponse(pathname: string, response: ResponseFacts): boolean {
  if (response.status !== 200 || response.redirected) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  if (response.headers.has("set-cookie")) return false;
  if (/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) return false;
  const isHtml = (response.headers.get("content-type") ?? "").startsWith("text/html");
  return pathname === SHELL_PATH ? isHtml : !isHtml;
}

/**
 * A front door (a reverse proxy, or `tailscale serve`) answers 502, 503 or 504
 * when the server behind it is down. For a page load that is the same as the
 * network failing.
 */
export function isFrontDoorFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** One chunk of Vite's build manifest (`.vite/manifest.json`). */
export interface BuildManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly imports?: ReadonlyArray<string>;
  readonly dynamicImports?: ReadonlyArray<string>;
  readonly css?: ReadonlyArray<string>;
}

/**
 * The files the worker stores when it installs: the shell, the icons and
 * manifest in the build's root, and the code the app needs to boot. That is
 * each entry, what the entry loads at once, and what those import. Route
 * chunks are left out; they are cached the first time they load.
 */
export function shellPrecacheList(
  manifest: Readonly<Record<string, BuildManifestChunk>>,
  rootFiles: ReadonlyArray<string>,
): Array<string> {
  const boot = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, followDynamic: boolean) => {
    const chunk = manifest[key];
    if (chunk === undefined || visited.has(key)) return;
    visited.add(key);
    boot.add(`/${chunk.file}`);
    for (const css of chunk.css ?? []) boot.add(`/${css}`);
    for (const imported of chunk.imports ?? []) visit(imported, false);
    if (followDynamic) for (const imported of chunk.dynamicImports ?? []) visit(imported, false);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key, true);
  const shellFiles = rootFiles
    .filter((file) => /\.(?:png|ico|svg|webmanifest)$/.test(file))
    .map((file) => `/${file}`)
    .toSorted();
  return [SHELL_PATH, ...shellFiles, ...boot];
}
