// magnesium: Profiles, made and managed in the app (goal 34)
import { createFileRoute } from "@tanstack/react-router";

import { PROFILE_TABS, type ProfileTab, ProfilesPage } from "../components/profiles/ProfilesPage";

const isTab = (value: unknown): value is ProfileTab =>
  typeof value === "string" && (PROFILE_TABS as ReadonlyArray<string>).includes(value);

export const Route = createFileRoute("/profiles")({
  validateSearch: (search: Record<string, unknown>): { name?: string; tab?: ProfileTab } => ({
    ...(typeof search.name === "string" ? { name: search.name } : {}),
    ...(isTab(search.tab) ? { tab: search.tab } : {}),
  }),
  component: ProfilesPage,
});
