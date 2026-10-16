import type { FooterItem } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import { createFooterRegistry, footerToggles, layoutFooter, setFooterItemShown } from "./footer.ts";

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
