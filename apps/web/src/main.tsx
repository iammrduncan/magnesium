import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { prepareProviderAuthDelivery } from "./providerAuthDelivery";
import { isElectron } from "./env";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
import { registerShellServiceWorker, watchForNewBuild } from "@magnesium/web"; // magnesium: goals 05, 24
import { toastManager } from "./components/ui/toast"; // magnesium: the new-build reload prompt

prepareProviderAuthDelivery();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

// magnesium: no Clerk managed-auth shell; pairing is the only sign-in (D13)

// magnesium: the shell service worker, so the installed PWA opens offline (goal 05)
registerShellServiceWorker({ enabled: import.meta.env.PROD && !isElectron });

// magnesium: an open page keeps running the build it loaded, which the server
// may no longer understand after an update; offer a reload when it changes
if (import.meta.env.PROD) {
  watchForNewBuild(() => {
    toastManager.add({
      type: "info",
      title: "Magnesium was updated",
      description: "Reload to use the new version. Until then, this page may not work with it.",
      timeout: 0,
      actionProps: { children: "Reload", onClick: () => window.location.reload() },
    });
  });
}

export const startup = router
  .load()
  .then(() => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <AppRoot router={router} />
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
