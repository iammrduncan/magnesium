import type { FleetMachine, HubSpoke } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  attachFromForm,
  describeAttached,
  describeEnvironmentKind,
  describeSpoke,
  specFromForm,
} from "./spokes.ts";

const form = {
  name: "cpu-host-2",
  node: "node-b",
  home: "/home/agent",
  volumeSize: "100Gi",
  opencodeUrl: "",
  opencodeModels: "",
  startNow: true,
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
    // Created stopped, so a machine's home can be copied into its volume before it starts.
    expect(specFromForm({ ...form, startNow: false })).toMatchObject({ replicas: 0 });
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

describe("attaching a machine", () => {
  it("takes a moved machine without a code, and a new one with its code", () => {
    expect(attachFromForm({ name: "cpu-host-2", gateway: "gateway", pairingCode: "" })).toEqual({
      name: "cpu-host-2",
      gateway: "gateway",
      pairingCode: null,
    });
    expect(
      attachFromForm({ name: " notebook ", gateway: "gateway", pairingCode: "0123456789ABCDEF" }),
    ).toEqual({ name: "notebook", gateway: "gateway", pairingCode: "0123456789ABCDEF" });
  });

  it("refuses a name its Service couldn't have, a missing gateway, and a short code", () => {
    expect(
      attachFromForm({ name: "Notebook", gateway: "gateway", pairingCode: "" }),
    ).toHaveProperty("problem");
    expect(attachFromForm({ name: "notebook", gateway: "", pairingCode: "" })).toHaveProperty(
      "problem",
    );
    expect(
      attachFromForm({ name: "notebook", gateway: "gateway", pairingCode: "short" }),
    ).toHaveProperty("problem");
  });

  it("says where it runs, and what's in the way", () => {
    const machine = {
      name: "notebook",
      gateway: "gateway",
      workload: "notebook-ws",
      paired: true,
      detail: null,
    };
    expect(describeAttached(machine)).toBe("In notebook-ws · through gateway");
    expect(describeAttached({ ...machine, workload: null })).toBe("Through gateway");
    expect(
      describeAttached({
        ...machine,
        paired: false,
        detail: "The hub pairs with it once it answers.",
      }),
    ).toBe("The hub pairs with it once it answers. · in notebook-ws · through gateway");
  });
});

describe("an environment's kind", () => {
  const fleet = (overrides: Partial<FleetMachine>): FleetMachine => ({
    name: "cpu-host-2",
    label: "cpu-host-2",
    kind: "machine",
    link: "connected",
    environmentId: null,
    serverVersion: null,
    release: null,
    deployment: null,
    node: null,
    workload: null,
    startedAt: null,
    lastSeenAt: null,
    threads: null,
    detail: null,
    ...overrides,
  });

  it("says bare metal, a workload, a Magnesium pod or the gateway", () => {
    expect(
      describeEnvironmentKind({
        fleet: fleet({ deployment: "bare-metal" }),
        spoke: undefined,
        attached: undefined,
      }),
    ).toBe("bare metal");
    expect(
      describeEnvironmentKind({
        fleet: fleet({ deployment: "attached", node: "node-b" }),
        spoke: undefined,
        attached: {
          name: "cpu-host-2",
          gateway: "gateway",
          workload: "notebook",
          paired: true,
          detail: null,
        },
      }),
    ).toBe("in notebook on node-b");
    expect(
      describeEnvironmentKind({
        fleet: undefined,
        spoke: {
          name: "cpu-host-2",
          gateway: "gateway",
          spec: { ...(specFromForm(form) as HubSpoke["spec"]), replicas: 0 },
          keys: [],
          status: null,
          paired: true,
          detail: null,
        },
        attached: undefined,
      }),
    ).toBe("Magnesium pod on node-b · stopped");
    expect(
      describeEnvironmentKind({
        fleet: fleet({ kind: "gateway", deployment: "pod", node: "node-a" }),
        spoke: undefined,
        attached: undefined,
      }),
    ).toBe("gateway · pod on node-a");
  });
});
