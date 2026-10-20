import { parseProfileInstanceId } from "@magnesium/contracts";
import { Link } from "@tanstack/react-router";
import { UsersRoundIcon } from "lucide-react";
import { useMemo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

/**
 * A banner for a thread whose profile is gone from its machine (goal 34):
 * deleted, or narrowed away. The thread keeps its history and the composer
 * has fallen back to another instance; this says so, and where to go.
 */
export function useProfileGoneBanner(input: {
  readonly threadId: string | null;
  readonly instanceId: string | null | undefined;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}): ComposerBannerStackItem | null {
  const { threadId, instanceId, entries } = input;
  return useMemo(() => {
    const profile = instanceId ? parseProfileInstanceId(instanceId) : null;
    // An empty list is a catalog still loading, not a profile gone.
    if (profile === null || entries.length === 0) return null;
    if (entries.some((entry) => entry.instanceId === instanceId)) return null;
    return {
      id: `profile-gone:${threadId ?? ""}:${instanceId}`,
      variant: "warning",
      icon: <UsersRoundIcon />,
      title: `The ${profile.profile} profile isn't on this machine any more`,
      description:
        "It was deleted, or no longer runs here. The thread keeps its history: pick another profile in the picker, or restore it from Profiles.",
      actions: (
        <Button size="xs" variant="outline" render={<Link to="/profiles" search={{}} />}>
          Open Profiles
        </Button>
      ),
    };
  }, [entries, instanceId, threadId]);
}
