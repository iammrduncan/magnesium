// @effect-diagnostics globalFetch:off globalDate:off - runs in the page from boot, outside any Effect runtime.

/** How often a page in view asks the server which build it serves. */
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Coming back into view checks at most this often. */
const MIN_GAP_MS = 60 * 1000;

/**
 * The entry script an `index.html` loads. Vite hashes its name, so it names
 * the build of the web app. Null for a page without one, such as a front
 * door's error page.
 */
export function entryScriptOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']?module\b/i.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src !== undefined) return src;
  }
  return null;
}

/**
 * Calls `onNewBuild` once when the server starts serving a different build of
 * the web app than this page runs. An open page, the installed app most of
 * all, keeps running the code it loaded, and a newer server may refuse it (a
 * new orchestration protocol, say), so the page should offer a reload. It
 * checks when the page comes back into view, and every half hour while it is
 * in view. `/index.html` is never cached by the shell worker (see `policy.ts`).
 */
export function watchForNewBuild(onNewBuild: () => void): void {
  const running =
    document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ??
    null;
  if (running === null) return;
  let told = false;
  let lastCheck = 0;
  const check = () => {
    if (told || document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastCheck < MIN_GAP_MS) return;
    lastCheck = now;
    void fetch("/index.html", { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : ""))
      .then((html) => {
        const served = entryScriptOf(html);
        if (told || served === null || served === running) return;
        told = true;
        onNewBuild();
      })
      .catch(() => undefined);
  };
  document.addEventListener("visibilitychange", check);
  window.setInterval(check, CHECK_EVERY_MS);
}
