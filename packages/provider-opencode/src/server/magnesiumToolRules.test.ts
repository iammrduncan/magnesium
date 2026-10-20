// magnesium: a profile's MCP tool permissions hold in every permission mode (goal 34, D67)
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { configToolRules, forT3Server, readConfigToolRules } from "./magnesiumToolRules.ts";

const profileConfig = {
  mcp: { hubtools: { type: "remote", url: "https://hub.example/mcp" } },
  permission: {
    bash: "ask",
    "hubtools_*": "allow",
    hubtools_list_profiles: "deny",
    hubtools_get_profile: "ask",
    "t3-code*_delete_profile": "deny",
    "other_*": "deny",
  },
};

describe("a profile's MCP tool rules", () => {
  it("are its MCP servers' and T3's tool rules, in order, and nothing else", () => {
    assert.deepStrictEqual(configToolRules(profileConfig), [
      { permission: "hubtools_*", pattern: "*", action: "allow" },
      { permission: "hubtools_list_profiles", pattern: "*", action: "deny" },
      { permission: "hubtools_get_profile", pattern: "*", action: "ask" },
      { permission: "t3-code*_delete_profile", pattern: "*", action: "deny" },
    ]);
    assert.deepStrictEqual(configToolRules({ permission: "ask" }), []);
    assert.deepStrictEqual(configToolRules(null), []);
  });

  it("name T3's tools for the session's own T3 server, or drop them without one", () => {
    const rules = configToolRules(profileConfig);
    assert.deepStrictEqual(
      forT3Server(rules, "t3-code-thread_1").map((rule) => rule.permission),
      [
        "hubtools_*",
        "hubtools_list_profiles",
        "hubtools_get_profile",
        "t3-code-thread_1_delete_profile",
      ],
    );
    assert.deepStrictEqual(
      forT3Server(rules, null).map((rule) => rule.permission),
      ["hubtools_*", "hubtools_list_profiles", "hubtools_get_profile"],
    );
  });

  it.effect("are read from OPENCODE_CONFIG_DIR, and are none without it", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mg-opencode-"));
      NodeFS.writeFileSync(NodePath.join(dir, "opencode.json"), JSON.stringify(profileConfig));
      const read = yield* readConfigToolRules({ OPENCODE_CONFIG_DIR: dir });
      assert.equal(read.length, 4);
      assert.deepStrictEqual(yield* readConfigToolRules({}), []);
      NodeFS.writeFileSync(NodePath.join(dir, "opencode.json"), "{ not json");
      assert.deepStrictEqual(yield* readConfigToolRules({ OPENCODE_CONFIG_DIR: dir }), []);
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
