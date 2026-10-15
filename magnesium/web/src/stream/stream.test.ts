import { describe, expect, it } from "@effect/vitest";

import { applyLiveLogItem, emptyLiveLog, mergeHistoryPage } from "./liveLog.ts";
import { applyLiveTableItem, emptyLiveTable, resumeFrom } from "./liveTable.ts";

interface Row {
  readonly name: string;
  readonly value: number;
}
const key = (row: Row) => row.name;

describe("live table state", () => {
  it("keeps the same state and row objects when nothing changed", () => {
    const opened = applyLiveTableItem(
      emptyLiveTable<Row>(),
      {
        _tag: "snapshot",
        sequence: 2,
        rows: [
          { name: "a", value: 1 },
          { name: "b", value: 1 },
        ],
      },
      key,
    );
    const a = opened.rows.get("a");

    const again = applyLiveTableItem(
      opened,
      {
        _tag: "snapshot",
        sequence: 2,
        rows: [
          { name: "a", value: 1 },
          { name: "b", value: 1 },
        ],
      },
      key,
    );
    expect(again).toBe(opened);

    const changed = applyLiveTableItem(
      opened,
      { _tag: "changes", sequence: 3, upserts: [{ name: "b", value: 2 }], removals: [] },
      key,
    );
    expect(changed.rows.get("a")).toBe(a);
    expect(changed.rows.get("b")).toEqual({ name: "b", value: 2 });
    expect(resumeFrom(changed)).toEqual({ afterSequence: 3 });
  });

  it("ignores changes it already applied, and applies removals", () => {
    const state = applyLiveTableItem(
      emptyLiveTable<Row>(),
      { _tag: "snapshot", sequence: 5, rows: [{ name: "a", value: 1 }] },
      key,
    );
    const stale = applyLiveTableItem(
      state,
      { _tag: "changes", sequence: 5, upserts: [{ name: "a", value: 9 }], removals: [] },
      key,
    );
    expect(stale).toBe(state);
    const removed = applyLiveTableItem(
      state,
      { _tag: "changes", sequence: 6, upserts: [], removals: ["a", "missing"] },
      key,
    );
    expect([...removed.rows.keys()]).toEqual([]);
    expect(resumeFrom(emptyLiveTable())).toEqual({});
  });
});

interface Entry {
  readonly sequence: number;
  readonly text: string;
}
const entries = (from: number, to: number): Entry[] =>
  Array.from({ length: to - from + 1 }, (_, index) => ({
    sequence: from + index,
    text: `entry ${from + index}`,
  }));

describe("live log state", () => {
  it("appends new items once, and pages older ones in front", () => {
    let state = applyLiveLogItem(emptyLiveLog<Entry>(), {
      _tag: "snapshot",
      sequence: 20,
      items: entries(11, 20),
      before: 11,
    });
    state = applyLiveLogItem(state, { _tag: "appended", sequence: 22, items: entries(19, 22) });
    expect(state.items.map((entry) => entry.sequence)).toEqual(
      entries(11, 22).map((e) => e.sequence),
    );

    state = mergeHistoryPage(state, { items: entries(1, 10), before: null });
    expect(state.items.length).toBe(22);
    expect(state.before).toBeNull();
    // Nothing older to merge once the log is complete.
    expect(mergeHistoryPage(state, { items: entries(1, 3), before: null })).toBe(state);
  });

  it("keeps at most its limit, dropping the oldest and remembering where to page back", () => {
    let state = applyLiveLogItem(
      emptyLiveLog<Entry>(),
      { _tag: "snapshot", sequence: 5, items: entries(1, 5), before: null },
      5,
    );
    state = applyLiveLogItem(state, { _tag: "appended", sequence: 8, items: entries(6, 8) }, 5);
    expect(state.items.map((entry) => entry.sequence)).toEqual([4, 5, 6, 7, 8]);
    expect(state.before).toBe(4);
  });
});
