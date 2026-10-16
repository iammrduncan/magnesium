import { describe, expect, it } from "@effect/vitest";

import { PAIRING_CODE_ENV, pairingCodeFromEnv } from "./pairingCode.ts";

describe("a pairing code from the environment", () => {
  it("is taken when long enough to be random, refused with a reason when not, and absent when unset", () => {
    expect(pairingCodeFromEnv({})).toBeNull();
    expect(pairingCodeFromEnv({ [PAIRING_CODE_ENV]: "  " })).toBeNull();
    expect(pairingCodeFromEnv({ [PAIRING_CODE_ENV]: " GATEWAY-BOOTSTRAP-0123456789\n" })).toEqual({
      code: "GATEWAY-BOOTSTRAP-0123456789",
    });
    expect(pairingCodeFromEnv({ [PAIRING_CODE_ENV]: "short" })).toMatchObject({
      refused: expect.stringContaining("shorter than 16 characters"),
    });
  });
});
