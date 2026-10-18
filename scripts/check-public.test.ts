// magnesium: tests for the public-content check (MAGNESIUM.md, Rules).
import { describe, expect, it } from "vite-plus/test";

import { addedLines, findHits, parseDenylist, watermark } from "./check-public.ts";

const labels = (hits: ReadonlyArray<{ label: string }>) => hits.map((hit) => hit.label);

describe("findHits", () => {
  it("flags private addresses and key shapes, and allows loopback and documentation ranges", () => {
    const line = "reach it at 192.168.4.20"; // public-check: allow (fixture)
    expect(labels(findHits("a.md", 1, line, []))).toEqual([
      "private IPv4 (192.168/16)",
      "IPv4 address",
    ]);
    const key = "token sk-abcdefghijklmnopqrstuv"; // public-check: allow (fixture)
    expect(labels(findHits("a.md", 1, key, []))).toEqual(["API key shape"]);
    expect(findHits("a.md", 1, "http://127.0.0.1:3773 and 192.0.2.10", [])).toEqual([]);
  });

  it("skips a line that carries the allow marker", () => {
    expect(findHits("a.md", 1, "10.0.0.1 # public-check: allow (a reason)", [])).toEqual([]);
  });

  it("applies the denylist everywhere but the files that name a person on purpose", () => {
    const denylist = parseDenylist("# names\n\\bLovelace\\b\ncs:\\bAda\\b\n");
    expect(labels(findHits("README.md", 3, "by ADA LOVELACE", denylist))).toEqual([
      "lab identifier",
    ]);
    expect(findHits("LICENSE", 3, "Copyright (c) 2026 Ada Lovelace", denylist)).toEqual([]);
    const line = "Copyright 10.1.2.3"; // public-check: allow (fixture)
    expect(labels(findHits("LICENSE", 3, line, denylist))).toContain("private IPv4 (10/8)");
  });
});

describe("addedLines", () => {
  it("numbers added lines in the new file and ignores deleted files", () => {
    const diff = [
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "diff --git a/upstream.ts b/upstream.ts",
      "--- a/upstream.ts",
      "+++ b/upstream.ts",
      "@@ -10 +10,2 @@",
      "-old",
      "+changed",
      "+added",
      "diff --git a/gone.md b/gone.md",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { file: "new.md", line: 1, text: "first" },
      { file: "new.md", line: 2, text: "second" },
      { file: "upstream.ts", line: 10, text: "changed" },
      { file: "upstream.ts", line: 11, text: "added" },
    ]);
  });
});

describe("watermark", () => {
  it("reads the last upstream commit fully inspected", () => {
    const sha = "81493efb71e8e8244f95d3e9f71d8369654ab151";
    expect(watermark(`**Last upstream commit fully inspected:** \`${sha}\`, tag v0.1.0`)).toBe(sha);
    expect(watermark("no watermark here")).toBeUndefined();
  });
});
