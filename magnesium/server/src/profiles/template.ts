import * as Schema from "effect/Schema";

import { FILES } from "./profileFolder.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * A new profile's files, as `magnesium-agents new` and the app write them. It
 * runs on every machine, new ones included, until it's narrowed (D67).
 */
export const profileTemplate = (
  name: string,
  description: string,
): Readonly<Record<string, string>> => ({
  [FILES.meta]: `# A Magnesium profile. Edit it, then run \`magnesium-agents check ${name}\`.
name: ${name}
description: ${encodeString(description)}

# Where it runs: "*" is every machine, new ones included; or list machine names.
# An empty list runs it on this server only.
machines: ["*"]

# claude or codex; add the other to harnesses to offer both.
harness: claude
# harnesses: [claude, codex]

# fenced (the default) or container. A thread can still choose native, like full access.
# sandbox:
#   level: fenced

# Environment variable NAMES the agent needs. Values come from the server's environment.
env: []

# display_name: ${name}
# accent: "#2f80ed"
`,
  [FILES.agents]: `# ${name}\n\n${description}\n\nWrite the agent's role and rules here.\n`,
});
