import { describe, expect, it } from "@effect/vitest";

import { isMagnesiumSandboxed, providerProbeDir } from "./sandbox.ts";

describe("Magnesium's sandbox levels", () => {
  it("knows which levels are Magnesium's own sandbox", () => {
    expect(isMagnesiumSandboxed({ MAGNESIUM_SANDBOX: "fenced" })).toBe(true);
    expect(isMagnesiumSandboxed({ MAGNESIUM_SANDBOX: "container" })).toBe(true);
    expect(isMagnesiumSandboxed({ MAGNESIUM_SANDBOX: "native" })).toBe(false);
    expect(isMagnesiumSandboxed({})).toBe(false);
  });

  it("checks a fenced provider outside the state folder the fence protects", () => {
    const state = "/srv/t3/userdata";
    expect(providerProbeDir({ MAGNESIUM_SANDBOX: "fenced", TMPDIR: "/var/tmp" }, state)).toBe(
      "/var/tmp",
    );
    expect(providerProbeDir({ MAGNESIUM_SANDBOX: "container" }, state)).toBe("/tmp");
    expect(providerProbeDir({ MAGNESIUM_SANDBOX: "native" }, state)).toBe(state);
  });
});
