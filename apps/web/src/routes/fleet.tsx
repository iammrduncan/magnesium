// magnesium: Fleet, every server the hub reaches (goal 04), and where the palette's Fleet actions open (goal 35)
import { createFileRoute } from "@tanstack/react-router";

import { FleetPage } from "../components/fleet/FleetPage";

export interface FleetSearch {
  /** The server to show, by its Fleet key: its name, or `@self` for the hub. */
  readonly server?: string;
  /** An action to ask about at once, from the palette. */
  readonly ask?: "update" | "rollback";
  /** Opens Add a machine. */
  readonly add?: true;
}

export const Route = createFileRoute("/fleet")({
  validateSearch: (search: Record<string, unknown>): FleetSearch => ({
    ...(typeof search.server === "string" ? { server: search.server } : {}),
    ...(search.ask === "update" || search.ask === "rollback" ? { ask: search.ask } : {}),
    // The router reads `?add=1` as the number 1.
    ...(search.add === true || search.add === 1 || search.add === "1"
      ? { add: true as const }
      : {}),
  }),
  component: FleetPage,
});
