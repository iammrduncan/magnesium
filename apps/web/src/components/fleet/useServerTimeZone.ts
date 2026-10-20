// magnesium: the time zone a server keeps, which its scheduled tasks' times are in (D64, goal 35)
import { fleetRows } from "@magnesium/web";
import { useMemo } from "react";

import { useFleetView } from "./fleetStore";

/** A server's time zone as Fleet knows it; null until it says, or when Fleet doesn't list it. */
export function useServerTimeZone(environmentId: string | null | undefined): string | null {
  const view = useFleetView();
  return useMemo(
    () =>
      environmentId == null
        ? null
        : (fleetRows(view.machines).find((row) => row.environmentId === environmentId)?.timeZone ??
          null),
    [view.machines, environmentId],
  );
}
