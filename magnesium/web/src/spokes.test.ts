import type { HubSpoke } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import { describeSpoke, specFromForm } from "./spokes.ts";

const form = {
  name: "cpu-host-2",
  node: "node-b",
  home: "/home/agent",
  volumeSize: "100Gi",
  opencodeUrl: "",
  opencodeModels: "",
};

describe("adding a spoke", () => {
  it("builds a spec with the defaults, or says what to fix", () => {
    expect(specFromForm(form)).toEqual({
      name: "cpu-host-2",
      node: "node-b",
      home: "/home/agent",
      hostname: "cpu-host-2",
      build: null,
      volumeSize: "100Gi",
      opencode: null,
      replicas: 1,
    });
    expect(
      specFromForm({
        ...form,
        opencodeUrl: "https://litellm.example.com/v1",
        opencodeModels: "a, b",
      }),
    ).toMatchObject({
      opencode: { baseUrl: "https://litellm.example.com/v1", models: ["a", "b"] },
    });
    expect(specFromForm({ ...form, name: "CPU Host" })).toMatchObject({
      problem: expect.stringContaining("lowercase"),
    });
    expect(specFromForm({ ...form, home: "home/agent" })).toMatchObject({
      problem: expect.stringContaining("full path"),
    });
    expect(specFromForm({ ...form, volumeSize: "lots" })).toMatchObject({
      problem: expect.stringContaining("100Gi"),
    });
    expect(specFromForm({ ...form, opencodeUrl: "https://x.example" })).toMatchObject({
      problem: expect.stringContaining("model"),
    });
  });
});

describe("a spoke's row", () => {
  const spoke = (overrides: Partial<HubSpoke>): HubSpoke => ({
    name: "cpu-host-2",
    gateway: "gateway",
    spec: specFromForm(form) as HubSpoke["spec"],
    keys: [],
    status: {
      name: "cpu-host-2",
      node: "node-b",
      build: "d05b2baa70",
      replicas: 1,
      ready: true,
      detail: null,
    },
    paired: true,
    detail: null,
    ...overrides,
  });

  it("says whether it runs, where and on which build, and what's in the way", () => {
    expect(describeSpoke(spoke({}))).toBe("Running · on node-b · d05b2baa70");
    expect(describeSpoke(spoke({ paired: false }))).toBe(
      "Up, waiting to pair with the hub · on node-b · d05b2baa70",
    );
    expect(
      describeSpoke(
        spoke({
          status: {
            name: "cpu-host-2",
            node: "node-b",
            build: null,
            replicas: 1,
            ready: false,
            detail: "node node-b is not allowed",
          },
        }),
      ),
    ).toBe("node node-b is not allowed · on node-b");
    expect(describeSpoke(spoke({ spec: { ...spoke({}).spec, replicas: 0 } }))).toBe(
      "Stopped · on node-b · d05b2baa70",
    );
    expect(
      describeSpoke(spoke({ status: null, detail: "Could not reach the gateway gateway." })),
    ).toBe("Could not reach the gateway gateway. · on node-b");
  });
});
