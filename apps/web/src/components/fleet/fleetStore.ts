// magnesium: one Fleet watch shared by the sidebar's place and the Fleet page (goal 04)
import {
  type FleetView,
  type FleetWatch,
  fleetRows,
  initialFleetView,
  magnesiumSocketUrl,
  watchFleet,
} from "@magnesium/web";
import { useSyncExternalStore } from "react";

let view: FleetView = initialFleetView;
let watch: FleetWatch | null = null;
const listeners = new Set<() => void>();

/** Opens the hub's Fleet stream on the first subscriber and closes it after the last. */
function subscribe(listener: () => void): () => void {
  // No page, no hub to watch: a test rendering a component that reads Fleet.
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  if (watch === null) {
    watch = watchFleet(magnesiumSocketUrl(window.location.href), (next) => {
      view = next;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watch !== null) {
      watch.dispose();
      watch = null;
      view = initialFleetView;
    }
  };
}

export function useFleetView(): FleetView {
  return useSyncExternalStore(subscribe, () => view);
}

/** The live watch while anything is subscribed, for Reconnect and paging. */
export function currentFleetWatch(): FleetWatch | null {
  return watch;
}

/** How many servers the hub can't reach right now; 0 until the stream is live. */
export function countOffline(current: FleetView): number {
  if (current.connection !== "live") return 0;
  return fleetRows(current.machines).filter(
    (machine) => machine.link === "offline" || machine.link === "no-access",
  ).length;
}
