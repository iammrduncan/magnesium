import type { FleetMachine } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  describeEvent,
  describeLink,
  describeThreads,
  describeVersion,
  fleetRows,
} from "./fleet.ts";
import { applyLiveTableItem, emptyLiveTable } from "./stream/liveTable.ts";

const machine = (name: string | null, overrides: Partial<FleetMachine> = {}): FleetMachine => ({
  name,
  label: name ?? "hub",
  kind: name === null ? "hub" : "machine",
  link: "connected",
  environmentId: EnvironmentId.make(`env-${name ?? "hub"}`),
  serverVersion: "0.0.45",
  release: "f0d9e1703a",
  deployment: null,
  startedAt: "2026-10-15T04:00:00.000Z",
  lastSeenAt: null,
  threads: { total: 4, running: 2, waiting: 1, approvals: 1, questions: 0 },
  detail: null,
  ...overrides,
});

describe("Fleet in the browser", () => {
  it("lists the hub first, then machines by name", () => {
    const state = applyLiveTableItem(
      emptyLiveTable<FleetMachine>(),
      {
        _tag: "snapshot",
        sequence: 1,
        rows: [machine("gpu-host-1"), machine("cpu-host-2"), machine(null), machine("cpu-host-1")],
      },
      (row) => row.name ?? "@self",
    );
    expect(fleetRows(state).map((row) => row.name)).toEqual([
      null,
      "cpu-host-1",
      "cpu-host-2",
      "gpu-host-1",
    ]);
  });

  it("says what a link is doing, and never shows unknown counts as zero", () => {
    const at = (iso: string) => `at ${iso.slice(11, 16)}`;
    expect(describeLink(machine("cpu-host-1"), at)).toBe("Connected");
    expect(
      describeLink(
        machine("cpu-host-1", { link: "offline", lastSeenAt: "2026-10-15T04:30:00.000Z" }),
        at,
      ),
    ).toBe("Offline, last seen at 04:30");
    expect(describeLink(machine("cpu-host-1", { link: "no-access" }), at)).toBe("No access");
    expect(describeThreads(machine("cpu-host-1").threads)).toBe("2 running · 1 waiting on you");
    expect(describeThreads(null)).toBe("Unknown");
    expect(
      describeEvent({
        sequence: 3,
        machine: "cpu-host-1",
        link: "offline",
        detail: "It stopped answering.",
        at: "2026-10-15T04:30:00.000Z",
      }),
    ).toBe("cpu-host-1 went offline: It stopped answering.");
  });

  it("shows each server's build, and calls out a machine on a different one", () => {
    const hub = machine(null);
    expect(describeVersion(hub, hub.release)).toBe("0.0.45 · f0d9e1703a");
    expect(describeVersion(machine("cpu-host-1"), hub.release)).toBe("0.0.45 · f0d9e1703a");
    expect(describeVersion(machine("cpu-host-2", { release: "80706f6b08" }), hub.release)).toBe(
      "0.0.45 · 80706f6b08 (not the hub's build)",
    );
    // A server that predates releases, or one in development, shows its version alone.
    expect(describeVersion(machine("gpu-host-1", { release: null }), hub.release)).toBe("0.0.45");
  });

  it("says how each server runs once it reports it", () => {
    const hub = machine(null, { deployment: "vm" });
    expect(describeVersion(hub, hub.release)).toBe("0.0.45 · f0d9e1703a · VM");
    expect(describeVersion(machine("cpu-host-1", { deployment: "pod" }), hub.release)).toBe(
      "0.0.45 · f0d9e1703a · pod",
    );
    expect(
      describeVersion(machine("cpu-host-2", { deployment: "bare-metal", release: null }), null),
    ).toBe("0.0.45 · bare metal");
  });
});
