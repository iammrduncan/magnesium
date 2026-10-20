import type { ProfileDetail, ProfilePushStatus, ProfileSummary } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  deliveryLine,
  instructionsFileProblem,
  newThreadTarget,
  permissionLine,
  profileListLine,
  withToolPermission,
} from "./profiles.ts";

const summary = (overrides: Partial<ProfileSummary> = {}): ProfileSummary => ({
  name: "serving",
  displayName: "Serving",
  description: "",
  avatar: "SE",
  accentColor: "#c2410c",
  harness: "claude",
  sandbox: "container",
  machines: ["*"],
  runsHere: true,
  instances: [],
  status: "ready",
  issues: [],
  ...overrides,
});

const push = (machine: string, overrides: Partial<ProfilePushStatus> = {}): ProfilePushStatus => ({
  machine,
  revision: "r1",
  checkedAt: null,
  error: null,
  refused: [],
  current: true,
  ...overrides,
});

describe("a profile's line in the list", () => {
  it("says it's refused first, then a machine refusing it, then one behind, else where it runs", () => {
    const refused = summary({
      status: "refused",
      issues: [{ level: "error", file: "profile.yaml", message: "x" }],
    });
    expect(profileListLine(refused, [])).toEqual({ text: "Refused · 1 issue", tone: "error" });
    expect(profileListLine(summary(), [push("gpu-a", { refused: ["serving"] })]).text).toBe(
      "1 machine refuses it",
    );
    expect(profileListLine(summary(), [push("gpu-a"), push("gpu-b", { current: false })])).toEqual({
      text: "1 machine behind",
      tone: "warning",
    });
    // A machine it doesn't name, or one the hub can't reach, isn't behind for it.
    const narrowed = summary({ machines: ["gpu-a"] });
    expect(profileListLine(narrowed, [push("gpu-a"), push("nas", { current: false })]).text).toBe(
      "gpu-a",
    );
    expect(
      profileListLine(summary(), [push("nas", { current: false, error: "Not connected." })]).text,
    ).toBe("1 machine offline");
    expect(profileListLine(summary(), []).text).toBe("Every machine");
    // Where the hub keeps its history, the line leads with its version, as the boards do.
    expect(
      profileListLine(summary({ version: 14, machines: ["gpu-a", "gpu-b", "nas"] }), []).text,
    ).toBe("v14 · 3 machines");
    expect(
      profileListLine(summary({ version: 9 }), [push("gpu-a"), push("gpu-b", { current: false })])
        .text,
    ).toBe("v9 · 1 machine behind");
  });
});

describe("delivery and tool permissions", () => {
  it("counts machines holding the current version", () => {
    expect(deliveryLine([], 3)).toBe("It runs on this hub only.");
    expect(
      deliveryLine(
        [
          { machine: "gpu-a", state: "current", checkedAt: null, detail: null },
          { machine: "nas", state: "offline", checkedAt: null, detail: null },
        ],
        14,
      ),
    ).toBe("1 of 2 machines hold v14.");
  });

  it("sums up a server's tools, and sets one without touching the rest", () => {
    const server = {
      name: "grafana",
      how: "https://grafana.example/mcp",
      secrets: [],
      permissions: { default: "ask" as const, tools: { search_dashboards: "allow" as const } },
    };
    expect(permissionLine(server)).toBe("1 allowed · 0 ask · 0 off · the rest ask first");
    expect(permissionLine({ ...server, permissions: { default: "allow", tools: {} } })).toBe(
      "Every tool: allow",
    );
    expect(withToolPermission(server.permissions, "delete_dashboard", "off")).toEqual({
      default: "ask",
      tools: { search_dashboards: "allow", delete_dashboard: "off" },
    });
  });

  it("takes a Markdown file of a new name", () => {
    expect(instructionsFileProblem("RUNBOOK.md", ["AGENTS.md"])).toBeUndefined();
    expect(instructionsFileProblem("AGENTS.md", ["AGENTS.md"])).toContain("already there");
    expect(instructionsFileProblem("notes.txt", [])).toContain("Markdown");
  });
});

describe("a profile's New thread", () => {
  const machines = [
    { name: null, environmentId: "env-hub", link: "connected" },
    { name: "gpu-a", environmentId: "env-gpu-a", link: "offline" },
    { name: "gpu-b", environmentId: "env-gpu-b", link: "connected" },
  ];
  // Only what newThreadTarget reads; the rest of a detail doesn't matter here.
  const detail = (
    summaryOverrides: Partial<ProfileSummary>,
    deliveries: ProfileDetail["deliveries"],
  ) => ({ summary: summary(summaryOverrides), deliveries }) as unknown as ProfileDetail;
  const everywhere = () => true;

  it("starts on the hub when it runs there, on its main instance", () => {
    const onHub = detail(
      {
        harness: "opencode",
        sandbox: "fenced",
        instances: [
          { instanceId: "mg-opencode-fenced-serving", harness: "opencode", sandbox: "fenced" },
        ],
      },
      [],
    );
    expect(newThreadTarget({ detail: onHub, machines, hasInstance: everywhere })).toEqual({
      environmentId: "env-hub",
      instanceId: "mg-opencode-fenced-serving",
    });
  });

  it("else on the first connected machine holding its current version and its instance", () => {
    const delivered = detail({ runsHere: false, harness: "claude", sandbox: "fenced" }, [
      { machine: "gpu-a", state: "current", checkedAt: null, detail: null },
      { machine: "gpu-b", state: "current", checkedAt: null, detail: null },
    ]);
    expect(newThreadTarget({ detail: delivered, machines, hasInstance: everywhere })).toEqual({
      environmentId: "env-gpu-b",
      instanceId: "mg-claude-fenced-serving",
    });
    // A machine without the harness has no instance for it: nowhere to start.
    expect(newThreadTarget({ detail: delivered, machines, hasInstance: () => false })).toBeNull();
  });
});
