// The shell service worker's entry (goal 05). `vitePlugin.ts` bundles it into
// the build's `sw.js` with the build's version, precache list and entry.
import { makeShellWorker } from "./shellWorker.ts";

// The worker scope's own types, kept local: the webworker lib clashes with the DOM lib.
interface WorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface WorkerFetchEvent extends WorkerEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
declare const self: {
  readonly location: Location;
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  fetch(request: Request): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: WorkerEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: WorkerFetchEvent) => void): void;
};
declare const __MAGNESIUM_SW_VERSION__: string;
declare const __MAGNESIUM_SW_PRECACHE__: ReadonlyArray<string>;
declare const __MAGNESIUM_SW_ENTRY__: string;

const worker = makeShellWorker({
  version: __MAGNESIUM_SW_VERSION__,
  precache: __MAGNESIUM_SW_PRECACHE__,
  entry: __MAGNESIUM_SW_ENTRY__,
  origin: self.location.origin,
  caches: self.caches,
  fetch: (request) => self.fetch(request),
});

// A new build's worker takes over at once. Page loads are network first, so
// this never changes what an online page loads; it only means the offline
// shell is the newest build's, and earlier builds' caches go straight away.
self.addEventListener("install", (event) => {
  event.waitUntil(worker.install().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(worker.activate().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const response = worker.respond(event.request, (promise) => event.waitUntil(promise));
  if (response !== undefined) event.respondWith(response);
});
