import { instanceSandbox, whereItRuns } from "@magnesium/web";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironment } from "../../state/environments";

/**
 * The machine and sandbox a thread's commands run in, for its approval card
 * (goal 34): "Runs on cpu-host-1 in the container sandbox".
 */
export function useApprovalWhere(
  environmentId: EnvironmentId,
  instanceId: string,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string | undefined {
  const label = useEnvironment(environmentId)?.label;
  return useMemo(() => {
    if (label === undefined) return undefined;
    const ids = entries.map((entry) => entry.instanceId as string);
    return whereItRuns(label, instanceSandbox(instanceId, ids)?.level);
  }, [label, instanceId, entries]);
}
