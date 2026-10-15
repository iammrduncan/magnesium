import { describe, expect, it } from "@effect/vitest";

import { instanceSandbox, profileDisplayName, sandboxesUrl, sandboxSiblings } from "./sandboxes.ts";

const IDS = [
  "mg-claude-fenced-scratch-a",
  "mg-claude-native-scratch-a",
  "mg-claude-container-scratch-a",
  "mg-codex-fenced-scratch-a",
  "codex",
  "mg_native_codex",
  "cursor",
];

describe("sandbox levels in the picker", () => {
  it("read a profile instance's level and profile from its id", () => {
    expect(instanceSandbox("mg-claude-native-scratch-a", IDS)).toEqual({
      level: "native",
      group: "profile:scratch-a:claude",
      profile: "scratch-a",
    });
  });

  it("call a stock instance with a native twin fenced, and leave others alone", () => {
    expect(instanceSandbox("codex", IDS)).toEqual({
      level: "fenced",
      group: "codex",
      profile: null,
    });
    expect(instanceSandbox("mg_native_codex", IDS)?.level).toBe("native");
    expect(instanceSandbox("cursor", IDS)).toBeNull();
  });

  it("offer the levels of one profile and harness, fenced first", () => {
    expect(sandboxSiblings("mg-claude-native-scratch-a", IDS)).toEqual([
      { instanceId: "mg-claude-fenced-scratch-a", level: "fenced" },
      { instanceId: "mg-claude-container-scratch-a", level: "container" },
      { instanceId: "mg-claude-native-scratch-a", level: "native" },
    ]);
    expect(sandboxSiblings("codex", IDS).map((sibling) => sibling.instanceId)).toEqual([
      "codex",
      "mg_native_codex",
    ]);
    expect(sandboxSiblings("cursor", IDS)).toEqual([]);
  });

  it("drop the level from a profile's display name", () => {
    expect(profileDisplayName("scratch-a · native")).toBe("scratch-a");
    expect(profileDisplayName("scratch-a")).toBe("scratch-a");
  });

  it("ask the hub about the machines it carries, and a server about itself", () => {
    expect(sandboxesUrl("https://hub.example/api/magnesium/env/cpu-host-1/")).toBe(
      "https://hub.example/api/magnesium/hub/machines/cpu-host-1/sandboxes",
    );
    expect(sandboxesUrl("https://hub.example/")).toBe(
      "https://hub.example/api/magnesium/agents/v1/sandboxes",
    );
  });
});
