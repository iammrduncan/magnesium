import type { ProfileList, ProfileSummary } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import { botConversation, botsOf } from "./bots.ts";

const summary = (name: string, overrides: Partial<ProfileSummary>): ProfileSummary => ({
  name,
  displayName: name,
  description: "",
  avatar: name.slice(0, 2).toUpperCase(),
  accentColor: "#0e7490",
  harness: "opencode",
  sandbox: "fenced",
  machines: ["*"],
  runsHere: true,
  instances: [],
  status: "ready",
  issues: [],
  ...overrides,
});

describe("bots (D68)", () => {
  it("are the profiles the hub runs, each on its main harness at its default level", () => {
    const list: ProfileList = {
      machine: "hub",
      folder: "/profiles",
      pushes: [],
      profiles: [
        summary("research", {
          harness: "opencode",
          instances: [
            { instanceId: "mg-opencode-native-research", harness: "opencode", sandbox: "native" },
            { instanceId: "mg-opencode-fenced-research", harness: "opencode", sandbox: "fenced" },
          ],
        }),
        // It runs on two machines, not the hub: no bot.
        summary("serving", { runsHere: false, machines: ["gpu-host-1", "gpu-host-2"] }),
        // The hub has none of its harnesses: no bot either.
        summary("reviewer", { harness: "codex", instances: [] }),
      ],
    };
    expect(botsOf(list).map((bot) => [bot.name, bot.instanceId])).toEqual([
      ["research", "mg-opencode-fenced-research"],
    ]);
  });

  it("talk in the newest open thread without a project on the hub that runs them", () => {
    const thread = (id: string, overrides: Partial<Record<string, string | null>>) => ({
      id,
      environmentId: "env-hub",
      projectId: "scratch",
      providerInstanceId: "mg-opencode-fenced-research",
      archivedAt: null,
      updatedAt: "2026-10-19T10:00:00.000Z",
      ...overrides,
    });
    const threads = [
      thread("older", { updatedAt: "2026-10-19T09:00:00.000Z" }),
      thread("current", {}),
      thread("archived", {
        archivedAt: "2026-10-19T11:00:00.000Z",
        updatedAt: "2026-10-19T11:00:00.000Z",
      }),
      thread("in-a-project", { projectId: "release-notes", updatedAt: "2026-10-19T12:00:00.000Z" }),
      thread("on-a-machine", {
        environmentId: "env-gpu-host-1",
        updatedAt: "2026-10-19T12:00:00.000Z",
      }),
      thread("native", {
        providerInstanceId: "mg-opencode-native-research",
        updatedAt: "2026-10-19T09:30:00.000Z",
      }),
      thread("another-bot", {
        providerInstanceId: "mg-opencode-fenced-triage",
        updatedAt: "2026-10-19T12:00:00.000Z",
      }),
    ];
    const where = {
      environmentId: "env-hub",
      scratchProjectIds: new Set(["scratch"]),
      profile: "research",
    };
    expect(botConversation(threads, where)?.id).toBe("current");
    // New conversation archives it; until the next one starts, there is none.
    expect(
      botConversation(
        threads.filter((t) => t.id !== "current" && t.id !== "older" && t.id !== "native"),
        where,
      ),
    ).toBeNull();
  });
});
