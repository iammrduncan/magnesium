import type { FleetMachine, FooterItem } from "@magnesium/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  createFooterRegistry,
  describeWaiting,
  footerToggles,
  layoutFooter,
  setFooterItemShown,
  waitingByMachine,
} from "./footer.ts";

const item = (
  id: string,
  side: FooterItem["side"],
  order: number,
  toggleLabel = id,
): FooterItem => ({
  id,
  side,
  order,
  label: id,
  detail: null,
  tone: "neutral",
  toggleLabel,
});

const registered = (...ids: ReadonlyArray<string>) =>
  new Map(ids.map((id) => [id, { id, popover: `${id} popover` }]));

describe("the footer registry", () => {
  it("takes namespaced ids once each, and its disposer removes only what it added", () => {
    const registry = createFooterRegistry<{ readonly id: string }>();
    let notified = 0;
    registry.subscribe(() => void (notified += 1));

    const dispose = registry.register({ id: "core:fleet" });
    const before = registry.current();
    expect([...before.keys()]).toEqual(["core:fleet"]);
    expect(() => registry.register({ id: "fleet" })).toThrow(/<namespace>:<name>/);
    expect(() => registry.register({ id: "Core:Fleet" })).toThrow(/<namespace>:<name>/);
    expect(() => registry.register({ id: "core:fleet" })).toThrow(/already registered/);
    // A refused registration changes nothing.
    expect(registry.current()).toBe(before);

    dispose();
    expect(registry.current().size).toBe(0);
    // An app registering the same id later is not removed by the first disposer.
    registry.register({ id: "core:fleet" });
    dispose();
    expect([...registry.current().keys()]).toEqual(["core:fleet"]);
    expect(notified).toBe(3);
  });
});

describe("the footer's layout", () => {
  const items = [
    item("gpu-board:load", "right", 80),
    item("core:needs-you", "left", 20),
    item("scheduler:failures", "right", 10),
    item("core:fleet", "left", 10),
    item("ingest-queue:pending", "right", 10),
  ];

  it("puts each item on its side, by order and then id", () => {
    const layout = layoutFooter(items, registered(...items.map((entry) => entry.id)), []);
    expect(layout.left.map((entry) => entry.item.id)).toEqual(["core:fleet", "core:needs-you"]);
    expect(layout.right.map((entry) => entry.item.id)).toEqual([
      "ingest-queue:pending",
      "scheduler:failures",
      "gpu-board:load",
    ]);
    expect(layout.left[0]?.registration).toEqual({
      id: "core:fleet",
      popover: "core:fleet popover",
    });
  });

  it("leaves out what this device hid, and rows nothing in the browser registered", () => {
    const layout = layoutFooter(
      items,
      registered("core:fleet", "core:needs-you", "gpu-board:load"),
      ["core:needs-you"],
    );
    expect(layout.left.map((entry) => entry.item.id)).toEqual(["core:fleet"]);
    expect(layout.right.map((entry) => entry.item.id)).toEqual(["gpu-board:load"]);
  });

  it("lists every registered item in settings, hidden ones too, in the bar's order", () => {
    const toggles = footerToggles(
      [item("gpu-board:load", "right", 1, "GPU load"), ...items.slice(1, 4)],
      registered("core:fleet", "core:needs-you", "gpu-board:load", "scheduler:failures"),
      ["core:fleet", "gpu-board:load"],
    );
    expect(toggles).toEqual([
      { id: "core:fleet", label: "core:fleet", shown: false },
      { id: "core:needs-you", label: "core:needs-you", shown: true },
      { id: "gpu-board:load", label: "GPU load", shown: false },
      { id: "scheduler:failures", label: "scheduler:failures", shown: true },
    ]);
  });

  it("hides and shows one item at a time, keeping the list as it was when nothing changes", () => {
    const none: ReadonlyArray<string> = [];
    const hidden = setFooterItemShown(none, "core:fleet", false);
    expect(hidden).toEqual(["core:fleet"]);
    expect(setFooterItemShown(hidden, "core:fleet", false)).toBe(hidden);
    expect(setFooterItemShown(hidden, "core:needs-you", true)).toBe(hidden);
    expect(setFooterItemShown(hidden, "core:fleet", true)).toEqual([]);
  });
});

const machine = (name: string | null, overrides: Partial<FleetMachine> = {}): FleetMachine => ({
  name,
  label: name ?? "hub",
  kind: name === null ? "hub" : "machine",
  link: "connected",
  environmentId: EnvironmentId.make(`env-${name ?? "hub"}`),
  serverVersion: "0.0.45",
  release: null,
  startedAt: "2026-10-15T04:00:00.000Z",
  lastSeenAt: null,
  threads: { total: 3, running: 0, waiting: 0, approvals: 0, questions: 0 },
  detail: null,
  ...overrides,
});

const thread = (environment: string, id: string, waiting: "approval" | "question" | null) => ({
  environmentId: `env-${environment}`,
  id,
  title: id,
  hasPendingApprovals: waiting === "approval",
  hasPendingUserInput: waiting === "question",
});

describe("Needs you", () => {
  it("lists machines with something waiting, then those it can't count, with the threads it knows", () => {
    const machines = [
      machine(null),
      machine("cpu-host-1", {
        threads: { total: 9, running: 1, waiting: 3, approvals: 2, questions: 1 },
      }),
      machine("gpu-host-2", { link: "offline", threads: null }),
      machine("gpu-host-1", {
        threads: { total: 2, running: 0, waiting: 1, approvals: 0, questions: 1 },
      }),
    ];
    const threads = [
      thread("cpu-host-1", "a", "approval"),
      thread("cpu-host-1", "b", null),
      thread("cpu-host-1", "c", "question"),
      thread("cpu-host-1", "d", "approval"),
      thread("gpu-host-2", "e", "approval"),
      thread("somewhere-else", "f", "approval"),
    ];
    const groups = waitingByMachine(machines, threads, 2);
    expect(groups.map((group) => group.machine.name)).toEqual([
      "cpu-host-1",
      "gpu-host-1",
      "gpu-host-2",
    ]);
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(groups[0]?.more).toBe(1);
    // The browser knows no waiting thread there; the count still says one.
    expect(groups[1]).toMatchObject({ threads: [], more: 0 });
    // What the browser holds for a machine the hub can't see may be stale: none listed.
    expect(groups[2]).toMatchObject({ threads: [], more: 0 });
  });

  it("says what waits on each machine, and never shows unknown counts as nothing", () => {
    expect(describeWaiting({ total: 9, running: 1, waiting: 3, approvals: 2, questions: 1 })).toBe(
      "2 approvals · 1 question",
    );
    expect(describeWaiting({ total: 9, running: 1, waiting: 1, approvals: 1, questions: 0 })).toBe(
      "1 approval",
    );
    expect(describeWaiting({ total: 1, running: 1, waiting: 0, approvals: 0, questions: 0 })).toBe(
      "Nothing waiting",
    );
    expect(describeWaiting(null)).toBe("Not counted, not connected");
  });
});
