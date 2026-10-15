const SERVICE_WORKER_URL = "/sw.js";

/**
 * Registers the shell service worker (goal 05) once the page has loaded.
 * Browsers offer service workers on secure origins only (HTTPS, localhost).
 * `enabled` is false in Vite dev, which has no `sw.js`; there it removes a
 * worker that a production build on the same origin left behind.
 */
export function registerShellServiceWorker(options: { readonly enabled: boolean }): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  if (!options.enabled) {
    void container
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter((registration) => registration.active?.scriptURL.endsWith(SERVICE_WORKER_URL))
            .map((registration) => registration.unregister()),
        ),
      )
      .catch(() => undefined);
    return;
  }
  // A failed registration only means no offline shell; the app works without one.
  const register = () => {
    void container.register(SERVICE_WORKER_URL, { scope: "/" }).catch(() => undefined);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
