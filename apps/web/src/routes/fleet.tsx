// magnesium: Fleet, every server the hub reaches (goal 04)
import { createFileRoute } from "@tanstack/react-router";

import { FleetPage } from "../components/fleet/FleetPage";

export const Route = createFileRoute("/fleet")({
  component: FleetPage,
});
