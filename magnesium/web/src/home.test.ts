import type { HomeAnswer, HomeItem } from "@magnesium/contracts";
import { describe, expect, it } from "@effect/vitest";

import { emptyLiveTable } from "./stream/liveTable.ts";
import {
  createAnswerHold,
  describeHome,
  homeNeeds,
  homeNeedsByMachine,
  homeRunning,
  waitedFor,
} from "./home.ts";

const item = (
  key: string,
  body: HomeItem["body"],
  since: string,
  pinnedAt: string | null = null,
): HomeItem =>
  ({
    key,
    threadId: key,
    title: key,
    projectTitle: null,
    since,
    body,
    machine: { name: null, label: "hub", environmentId: null },
    reachable: true,
    pinnedAt,
  }) as HomeItem;

const approval: HomeItem["body"] = {
  _tag: "approval",
  requestId: "r",
  requestKind: "command",
  detail: "ls",
  choices: [],
};
const question: HomeItem["body"] = { _tag: "question", requestId: "q", questions: [] };
const plan: HomeItem["body"] = {
  _tag: "plan",
  planId: "p",
  markdown: "1. Do it",
  truncated: false,
};

const tableOf = (items: ReadonlyArray<HomeItem>) => ({
  ...emptyLiveTable<HomeItem>(),
  rows: new Map(items.map((row) => [row.key, row])),
});

describe("Home's order", () => {
  it("ranks kind first, then the longest wait, with a pin on top (D18)", () => {
    const items = tableOf([
      item("plan-old", plan, "2026-10-16T00:00:00.000Z"),
      item("question-new", question, "2026-10-16T01:30:00.000Z"),
      item("approval-new", approval, "2026-10-16T01:20:00.000Z"),
      item("approval-old", approval, "2026-10-16T01:00:00.000Z"),
      item("working", { _tag: "running" }, "2026-10-16T00:30:00.000Z"),
    ]);
    expect(homeNeeds(items).map((need) => need.key)).toEqual([
      "approval-old",
      "approval-new",
      "question-new",
      "plan-old",
    ]);
    expect(homeRunning(items).map((running) => running.key)).toEqual(["working"]);

    const pinned = tableOf([
      ...items.rows.values(),
      item("plan-pinned", plan, "2026-10-16T01:40:00.000Z", "2026-10-16T02:00:00.000Z"),
    ]);
    expect(homeNeeds(pinned)[0]?.key).toBe("plan-pinned");
  });

  it("writes waits and the header as the board does", () => {
    const now = Date.parse("2026-10-16T02:00:00.000Z");
    expect(waitedFor("2026-10-16T01:59:40.000Z", now)).toBe("now");
    expect(waitedFor("2026-10-16T01:54:00.000Z", now)).toBe("6m");
    expect(waitedFor("2026-10-15T23:00:00.000Z", now)).toBe("3h");
    expect(waitedFor("2026-10-13T02:00:00.000Z", now)).toBe("3d");
    expect(
      describeHome({
        key: "home",
        counts: { approval: 3, question: 1, plan: 1, failure: 0, total: 5, running: 4 },
        unseen: [],
      }),
    ).toBe("5 need you · 4 running");
    expect(
      describeHome({
        key: "home",
        counts: { approval: 0, question: 0, plan: 0, failure: 0, total: 0, running: 0 },
        unseen: ["gpu-host-2"],
      }),
    ).toBe("Nothing needs you · not counted: gpu-host-2");
  });
});

describe("Needs you in the footer", () => {
  it("lists each machine's needs in Home's order, then the machines the hub can't see", () => {
    const on = (machine: string, key: string, reachable = true) => ({
      ...item(key, approval, "2026-10-16T01:00:00.000Z"),
      machine: { name: machine, label: machine, environmentId: null },
      reachable,
    });
    const groups = homeNeedsByMachine(
      [
        on("gpu-host-2", "a"),
        on("cpu-host-1", "b"),
        on("gpu-host-2", "c"),
        on("cpu-host-2", "d", false),
      ],
      ["cpu-host-2", "gpu-host-1"],
      1,
    );
    expect(
      groups.map((group) => [
        group.label,
        group.reachable,
        group.needs.map((need) => need.key),
        group.more,
      ]),
    ).toEqual([
      ["gpu-host-2", true, ["a"], 1],
      ["cpu-host-1", true, ["b"], 0],
      ["cpu-host-2", false, ["d"], 0],
      ["gpu-host-1", false, [], 0],
    ]);
  });
});

/** Timers the test runs by hand. */
const manualTimers = () => {
  let clock = 0;
  const pending: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => clock,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: clock + ms, run };
      pending.push(timer);
      return () => void pending.splice(pending.indexOf(timer), 1);
    },
    advance: (ms: number) => {
      clock += ms;
      for (const timer of pending.filter((candidate) => candidate.at <= clock)) {
        pending.splice(pending.indexOf(timer), 1);
        timer.run();
      }
    },
  };
};

const accept: HomeAnswer = { _tag: "approval", requestId: "r", decision: "accept" };

describe("the hold before an answer is sent", () => {
  it("sends after five seconds, and not before", async () => {
    const timers = manualTimers();
    const sent: Array<string> = [];
    const hold = createAnswerHold({
      send: async (key) => void sent.push(key),
      now: timers.now,
      setTimer: timers.setTimer,
    });
    hold.hold("a", accept, "Approving");
    expect(hold.current().get("a")).toMatchObject({ state: "holding", sendsAt: 5_000 });
    timers.advance(4_999);
    expect(sent).toEqual([]);
    timers.advance(1);
    expect(sent).toEqual(["a"]);
    await Promise.resolve();
    expect(hold.current().get("a")?.state).toBe("sent");
  });

  it("sends nothing when undone, and the card comes back", () => {
    const timers = manualTimers();
    const sent: Array<string> = [];
    const hold = createAnswerHold({
      send: async (key) => void sent.push(key),
      now: timers.now,
      setTimer: timers.setTimer,
    });
    hold.hold("a", accept, "Approving");
    timers.advance(3_000);
    hold.undo("a");
    expect(hold.current().has("a")).toBe(false);
    timers.advance(10_000);
    expect(sent).toEqual([]);
  });

  it("keeps the reason when the hub refuses, until the card is cleared", async () => {
    const timers = manualTimers();
    const hold = createAnswerHold({
      send: () => Promise.reject(new Error("gpu-host-2 is offline. Answer it when it's back.")),
      now: timers.now,
      setTimer: timers.setTimer,
    });
    hold.hold("a", accept, "Approving");
    timers.advance(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(hold.current().get("a")).toMatchObject({
      state: "failed",
      error: "gpu-host-2 is offline. Answer it when it's back.",
    });
    hold.dismiss("a");
    expect(hold.current().has("a")).toBe(false);
  });
});
