import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup, RequiredScope } from "@magnesium/contracts";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Option from "effect/Option";

/**
 * What the hub calls on a gateway. It holds the token pairing gave it, which
 * carries the standard client scopes, not the administrative ones.
 */
const HUB_CALLS_ON_A_GATEWAY = [
  MAGNESIUM_WS_METHODS.spokesList,
  MAGNESIUM_WS_METHODS.spokesApply,
  MAGNESIUM_WS_METHODS.spokesRemove,
  MAGNESIUM_WS_METHODS.spokesAttached,
  MAGNESIUM_WS_METHODS.spokesAttachedPaired,
];

describe("the hub's calls on a gateway", () => {
  it("need only the scopes a paired hub holds", () => {
    for (const method of HUB_CALLS_ON_A_GATEWAY) {
      const rpc = MagnesiumRpcGroup.requests.get(method);
      expect(rpc, method).toBeDefined();
      const scope = Option.getOrUndefined(Context.getOption(rpc!.annotations, RequiredScope));
      expect(AuthStandardClientScopes, method).toContain(scope);
    }
  });
});
