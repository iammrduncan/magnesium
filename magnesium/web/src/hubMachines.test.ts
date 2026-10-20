import type { HubMachine } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { hubConnectionRegistrations, hubMachineNameOf, machinesToMove } from "./hubMachines.ts";

const machine = (overrides: Partial<HubMachine>): HubMachine => ({
  name: "cpu-host-1",
  label: "cpu-host-1",
  environmentId: EnvironmentId.make("env-cpu-host-1"),
  access: "ready",
  accessExpiresAt: null,
  online: true,
  source: "deploy",
  ...overrides,
});

describe("hubConnectionRegistrations", () => {
  it("registers each machine the hub can reach under the hub's origin", () => {
    const [registration, ...rest] = hubConnectionRegistrations("https://hub.example.test/", [
      machine({}),
      machine({ name: "gpu-host-1", access: "missing" }),
      machine({ name: "gpu-host-2", environmentId: null }),
    ]);
    expect(rest).toEqual([]);
    expect(registration?.target).toMatchObject({
      _tag: "HubConnectionTarget",
      environmentId: "env-cpu-host-1",
      label: "cpu-host-1",
      httpBaseUrl: "https://hub.example.test/api/magnesium/env/cpu-host-1/",
      wsBaseUrl: "wss://hub.example.test/api/magnesium/env/cpu-host-1/",
    });
    expect(hubMachineNameOf(registration!.target)).toBe("cpu-host-1");
  });

  it("knows which URLs are not hub machines", () => {
    expect(hubMachineNameOf({ httpBaseUrl: "https://hub.example.test/" })).toBeNull();
    expect(
      hubMachineNameOf({ httpBaseUrl: "https://hub.example.test/api/magnesium/env/a/b/" }),
    ).toBeNull();
  });
});

describe("machinesToMove", () => {
  it("moves a token this browser holds only to a machine the hub cannot reach yet", () => {
    const saved = new Map([
      [EnvironmentId.make("env-cpu-host-1"), "token-1"],
      [EnvironmentId.make("env-gpu-host-1"), "token-2"],
    ]);
    expect(
      machinesToMove(
        [
          machine({}),
          machine({
            name: "gpu-host-1",
            environmentId: EnvironmentId.make("env-gpu-host-1"),
            access: "expired",
          }),
          machine({ name: "gpu-host-2", environmentId: null, access: "missing" }),
        ],
        saved,
      ),
    ).toEqual([{ name: "gpu-host-1", bearerToken: "token-2" }]);
  });
});
