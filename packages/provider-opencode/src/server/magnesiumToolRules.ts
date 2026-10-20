// magnesium: a profile's MCP tool permissions hold in every permission mode (goal 34, D67)
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface ToolRule {
  readonly permission: string;
  readonly pattern: string;
  readonly action: "allow" | "ask" | "deny";
}

/** How a config names T3's own MCP server, whatever a thread's server is called. */
export const T3_SERVER_PATTERN = "t3-code*";

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/** OpenCode's permission name for an MCP server's tools: `<server>_<tool>`. */
const toolPrefix = (server: string) => `${server.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}_`;

/**
 * The rules an opencode.json sets for MCP tools, in its order: its own
 * servers' (`<server>_<tool>`) and T3's (`t3-code*_<tool>`). A session gets
 * its permission mode's rules after the config's, and the last matching rule
 * wins, so without these a mode would override them: full access would run a
 * tool that is off, and Supervised would ask for one that is allowed.
 */
export const configToolRules = (config: unknown): ReadonlyArray<ToolRule> => {
  if (typeof config !== "object" || config === null) return [];
  const { mcp, permission } = config as { readonly mcp?: unknown; readonly permission?: unknown };
  if (typeof permission !== "object" || permission === null) return [];
  const prefixes = [
    `${T3_SERVER_PATTERN}_`,
    ...(typeof mcp === "object" && mcp !== null ? Object.keys(mcp).map(toolPrefix) : []),
  ];
  const rules: ToolRule[] = [];
  for (const [name, value] of Object.entries(permission)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const patterns: ReadonlyArray<readonly [string, unknown]> =
      typeof value === "string"
        ? [["*", value]]
        : typeof value === "object" && value !== null
          ? Object.entries(value)
          : [];
    for (const [pattern, action] of patterns) {
      if (typeof action === "string" && ACTIONS.has(action)) {
        rules.push({ permission: name, pattern, action: action as ToolRule["action"] });
      }
    }
  }
  return rules;
};

/** `rules` with T3's tools named for this session's T3 server, or dropped when it has none. */
export const forT3Server = (
  rules: ReadonlyArray<ToolRule>,
  serverName: string | null,
): ReadonlyArray<ToolRule> =>
  rules.flatMap((rule) =>
    !rule.permission.startsWith(`${T3_SERVER_PATTERN}_`)
      ? [rule]
      : serverName === null
        ? []
        : [
            {
              ...rule,
              permission: `${serverName}_${rule.permission.slice(T3_SERVER_PATTERN.length + 1)}`,
            },
          ],
  );

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** configToolRules of the opencode.json in `environment`'s OPENCODE_CONFIG_DIR; none without one. */
export const readConfigToolRules = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const dir = environment.OPENCODE_CONFIG_DIR;
    if (dir === undefined || dir === "") return [];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(dir, "opencode.json"));
    return configToolRules(yield* decodeJson(text));
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ToolRule> => []));

/** Reads the instance's tool rules when a session needs them; the driver provides it. */
export class OpenCodeToolRules extends Context.Reference<Effect.Effect<ReadonlyArray<ToolRule>>>(
  "@t3tools/provider-opencode/magnesiumToolRules/OpenCodeToolRules",
  { defaultValue: () => Effect.succeed([]) },
) {}
