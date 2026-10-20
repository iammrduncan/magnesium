import type { FleetMachine } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOffers,
  confirmUpkeep,
  restoreOffer,
  upkeepNotes,
  upkeepStatus,
} from "./fleetUpkeep.ts";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const at = (iso: string) => iso.slice(5, 16);

const server = (name: string | null, overrides: Partial<FleetMachine> = {}): FleetMachine => ({
  name,
  label: name ?? "hub",
  kind: name === null ? "hub" : "machine",
  link: "connected",
  environmentId: EnvironmentId.make(`env-${name ?? "hub"}`),
  serverVersion: "0.0.45",
  release: "c4e81f2aaa",
  deployment: "bare-metal",
  node: null,
  workload: null,
  startedAt: "2026-10-20T04:00:00.000Z",
  lastSeenAt: null,
  threads: null,
  detail: null,
  previousRelease: "7b2f9e4bbb",
  platform: "linux-x64",
  timeZone: "Europe/Berlin",
  launcher: "systemd",
  backups: { newestAt: "2026-10-20T03:40:00.000Z", failure: null },
  activity: null,
  lastResult: null,
  ...overrides,
});

const hub = server(null);

describe("Fleet's upkeep notes", () => {
  it("says nothing about a server that is like the hub and backed up today", () => {
    expect(upkeepNotes(server("gpu-a"), hub, NOW, at)).toEqual([]);
  });

  it("notes a build behind the hub, a failed backup and another clock", () => {
    const notes = upkeepNotes(
      server("kb-host", {
        release: "7b2f9e4bbb",
        timeZone: "America/New_York",
        backups: {
          newestAt: "2026-10-19T02:09:00.000Z",
          failure: { at: "2026-10-20T02:10:00.000Z", reason: "No space left" },
        },
      }),
      hub,
      NOW,
      at,
    );
    expect(notes).toEqual([
      { kind: "behind", tone: "warning", text: "On 7b2f9e4bbb, not the hub's c4e81f2aaa" },
      { kind: "backup-failed", tone: "error", text: "Backup failed 10-20T02:10" },
      { kind: "clock", tone: "warning", text: "Clock on New York time, not the hub's Berlin" },
    ]);
  });

  it("warns when the newest backup is more than two days old, or there is none", () => {
    expect(
      upkeepNotes(
        server("nas", { backups: { newestAt: "2026-10-17T03:20:00.000Z", failure: null } }),
        hub,
        NOW,
        at,
      ),
    ).toEqual([{ kind: "backup-old", tone: "warning", text: "Newest backup is from 10-17T03:20" }]);
    expect(
      upkeepNotes(server("new", { backups: { newestAt: null, failure: null } }), hub, NOW, at),
    ).toEqual([{ kind: "no-backup", tone: "warning", text: "No backup yet" }]);
    // A server that predates its own backups says nothing about them.
    expect(upkeepNotes(server("old", { backups: null }), hub, NOW, at)).toEqual([]);
  });
});

describe("which of Update, Roll back and Restore a server offers", () => {
  it("offers Update to a machine behind the hub, and Roll back where it has a build before", () => {
    expect(buildOffers(server("gpu-a", { release: "7b2f9e4bbb" }), hub)).toEqual({
      update: { offered: true, reason: null },
      rollback: { offered: true, reason: null },
    });
    expect(buildOffers(server("gpu-a", { previousRelease: null }), hub)).toEqual({
      update: { offered: false, reason: null },
      rollback: { offered: false, reason: null },
    });
  });

  it("never offers Update on the hub, whose build the others follow, but rolls it back", () => {
    expect(buildOffers(hub, hub)).toEqual({
      update: { offered: false, reason: null },
      rollback: { offered: true, reason: null },
    });
  });

  it("changes a pod's build through its gateway, without a launcher of its own", () => {
    expect(
      buildOffers(
        server("gpu-b", { deployment: "pod", launcher: "container", release: "7b2f9e4bbb" }),
        hub,
      ).update.offered,
    ).toBe(true);
  });

  it("says why a workload's machine, or one nothing restarts, isn't changed from here", () => {
    expect(
      buildOffers(server("w", { deployment: "attached", release: "7b2f9e4bbb" }), hub),
    ).toEqual({
      update: { offered: false, reason: "Its workload's deploy sets its build." },
      rollback: { offered: false, reason: "Its workload's deploy sets its build." },
    });
    expect(
      buildOffers(server("mac", { launcher: null, release: "7b2f9e4bbb" }), hub).update,
    ).toEqual({
      offered: false,
      reason: "Nothing on it restarts it on another build: change it with its deploy.",
    });
    expect(restoreOffer(server("mac", { launcher: null })).offered).toBe(false);
    expect(
      restoreOffer(server("w", { deployment: "attached", launcher: "container" })).offered,
    ).toBe(true);
  });

  it("offers nothing while it is offline or busy", () => {
    const busy = server("gpu-a", {
      release: "7b2f9e4bbb",
      activity: { kind: "update", text: "Sending…", since: "2026-10-20T11:59:00.000Z" },
    });
    expect(buildOffers(busy, hub).update.offered).toBe(false);
    expect(
      buildOffers(server("gpu-a", { link: "offline", release: "7b2f9e4bbb" }), hub).update.offered,
    ).toBe(false);
    expect(restoreOffer(busy).offered).toBe(false);
  });
});

describe("what an action asks first", () => {
  it("says the hub's page reconnects on its own after the hub rolls back", () => {
    expect(confirmUpkeep({ kind: "rollback" }, hub, hub)).toMatchObject({
      title: "Roll hub back to 7b2f9e4bbb?",
      body: "The hub restarts on the build it had before. This page loses it for a minute and reconnects on its own.",
    });
  });

  it("names what restarts for a pod, and the build a failed update goes back to", () => {
    const pod = server("gpu-b", { deployment: "pod", release: "7b2f9e4bbb" });
    expect(confirmUpkeep({ kind: "update" }, pod, hub)).toMatchObject({
      title: "Update gpu-b to c4e81f2aaa?",
      body: "gpu-b's pod restarts on the hub's build, through its gateway. Its home and threads stay.",
      after: "If the new build doesn't start, gpu-b goes back to 7b2f9e4bbb, and Fleet says why.",
    });
    expect(
      confirmUpkeep(
        { kind: "restore", backup: "20261019T020900Z", when: "yesterday 02:09" },
        pod,
        hub,
      ),
    ).toMatchObject({ title: "Restore gpu-b from yesterday 02:09?", destructive: true });
  });
});

describe("a server's upkeep status", () => {
  it("shows work under way, then how the last change went, never a backup", () => {
    expect(
      upkeepStatus(
        server("gpu-a", { activity: { kind: "update", text: "Sending c4e81f2aaa…", since: "x" } }),
      ),
    ).toEqual({ tone: "info", text: "Sending c4e81f2aaa…" });
    const result = { from: "a", to: "b", at: "2026-10-20T11:00:00.000Z" };
    expect(
      upkeepStatus(
        server("gpu-a", {
          lastResult: { ...result, kind: "update", ok: false, detail: "b stopped 3 times" },
        }),
      ),
    ).toEqual({ tone: "error", text: "b stopped 3 times" });
    expect(
      upkeepStatus(
        server("gpu-a", { lastResult: { ...result, kind: "backup", ok: true, detail: "x" } }),
      ),
    ).toBeNull();
  });
});
