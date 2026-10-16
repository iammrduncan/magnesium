// magnesium: Home, what needs you on every machine (goal 06)
import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/home/HomePage";

export const Route = createFileRoute("/home")({
  component: HomePage,
});
