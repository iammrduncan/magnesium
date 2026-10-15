import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * Shown in place of the app when the hub can't be reached at boot (goal 05).
 * The installed PWA opens from its cached shell even then, and this says so
 * instead of showing stale data or the pairing page. Retry runs the boot
 * again, and so does the browser coming back online.
 */
export function OfflineScreen() {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const retryOnline = () => void router.invalidate();
    window.addEventListener("online", retryOnline);
    return () => window.removeEventListener("online", retryOnline);
  }, [router]);

  const retry = () => {
    setRetrying(true);
    void router.invalidate().finally(() => setRetrying(false));
  };

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Offline"
        description="This device can't reach the hub. Check the network, or that the hub is running. Magnesium tries again when the network comes back."
      />
      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" disabled={retrying} onClick={retry}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </StandalonePage>
  );
}
