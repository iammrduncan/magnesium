import { describe, expect, it } from "@effect/vitest";

import { podDidNotComeUp } from "./FleetUpkeep.ts";

describe("a pod's build that doesn't come up", () => {
  it("says the cluster's reason when its gateway has one, and where it goes back to", () => {
    expect(
      podDidNotComeUp(
        "cpu-host-2",
        "1a2b3c4d5e",
        "0f1e2d3c4b",
        'Container image "localhost/magnesium:1a2b3c4d5e" is not present with pull policy of Never.',
      ),
    ).toBe(
      `1a2b3c4d5e didn't come up within 10m: Container image "localhost/magnesium:1a2b3c4d5e" is not present with pull policy of Never. cpu-host-2 is going back to 0f1e2d3c4b.`,
    );
    // Still starting, or no word from the gateway: the time alone.
    expect(podDidNotComeUp("cpu-host-2", "1a2b3c4d5e", null, "Starting.")).toBe(
      "1a2b3c4d5e didn't come up within 10m.",
    );
  });
});
