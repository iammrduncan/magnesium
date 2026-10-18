import {
  type ProfileCheckResult,
  type ProfileList,
  PROFILE_NAME_PATTERN,
  type SandboxList,
} from "@magnesium/contracts";
import { ServerSettings } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { InstanceSource, ProfilesConfig } from "../profiles/catalog.ts";
import { detectSetup, wrapperCandidates } from "../profiles/setup.ts";
import { findOperation } from "./operations.ts";

/**
 * `t3 agents ...`, installed as `magnesium-agents`: the agents API's operations
 * at the terminal (D37). It reads the same folder and
 * settings the server does, so it works with the server stopped.
 *
 *   magnesium-agents list                  every profile, and what it runs as here
 *   magnesium-agents check [name...]       refuse what sync refuses; exits 1 on errors
 *   magnesium-agents sandboxes             the levels this machine runs, and how to add one
 *   magnesium-agents new <name>            a new profile folder to edit
 */

export class AgentCommandError extends Schema.TaggedError<AgentCommandError>()(
  "AgentCommandError",
  { message: Schema.String },
) {}

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** This server's profile config and settings, from T3CODE_HOME (the unit sets it). */
const cliLayer = (baseDir: string | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = path.resolve(
        baseDir ?? process.env.T3CODE_HOME ?? path.join(process.env.HOME ?? "", ".magnesium"),
      );
      const detected = yield* detectSetup({
        env: process.env,
        baseDir: home,
        wrapperCandidates: yield* wrapperCandidates,
      });
      const instances = fs.readFileString(path.join(home, "userdata", "settings.json")).pipe(
        Effect.flatMap(decodeSettings),
        Effect.map((settings) => settings.providerInstances),
        Effect.orElseSucceed(() => ({})),
      );
      return Layer.mergeAll(
        Layer.succeed(ProfilesConfig, ProfilesConfig.of(detected)),
        Layer.succeed(InstanceSource, InstanceSource.of({ instances })),
      );
    }),
  );

const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription("Magnesium's state home (default: T3CODE_HOME, else ~/.magnesium)."),
  Flag.optional,
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON."),
  Flag.withDefault(false),
);

const runOperation = (name: string, input: unknown, baseDir: string | undefined) =>
  Effect.gen(function* () {
    const operation = findOperation(name);
    if (operation === undefined) return yield* new AgentCommandError({ message: `No ${name}.` });
    return yield* operation.run(input).pipe(Effect.provide(cliLayer(baseDir)));
  });

const LEVEL_ORDER = ["fenced", "container", "native", "microvm"];

/** What runs here, as "claude, codex · fenced, container, native", or why nothing does. */
export const runsHereText = (profile: ProfileList["profiles"][number]): string => {
  if (!profile.runsHere) return "not here";
  if (profile.instances.length === 0) {
    const why = profile.issues[0]?.message;
    return `nothing here yet${why ? ` (${why})` : ""}`;
  }
  const unique = (values: ReadonlyArray<string>) =>
    values.filter((value, index) => values.indexOf(value) === index);
  const harnesses = unique(profile.instances.map((instance) => instance.harness));
  const levels = unique(profile.instances.map((instance) => instance.sandbox)).toSorted(
    (a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b),
  );
  return `${harnesses.join(", ")} · ${levels.join(", ")}`;
};

export const showList = (list: ProfileList) => {
  if (list.profiles.length === 0) return `No profiles in ${list.folder}.`;
  const lines = list.profiles.map((profile) =>
    [
      profile.name.padEnd(20),
      profile.status.padEnd(8),
      `default ${profile.harness}/${profile.sandbox}`.padEnd(26),
      runsHereText(profile),
      profile.machines.length > 0 ? `  machines: ${profile.machines.join(", ")}` : "",
    ].join(""),
  );
  const pushes = list.pushes.map(
    (push) =>
      `pushed to ${push.machine}: ${push.error ?? `revision ${push.revision}`}${push.refused.length > 0 ? `, refused ${push.refused.join(", ")}` : ""}`,
  );
  return [`${list.machine}: ${list.folder}`, ...lines, ...pushes].join("\n");
};

const showCheck = (result: ProfileCheckResult) =>
  [
    ...result.profiles.flatMap((profile) =>
      profile.issues.length === 0
        ? [`${profile.name}: ok`]
        : profile.issues.map(
            (issue) => `${profile.name}: ${issue.level} ${issue.file}: ${issue.message}`,
          ),
    ),
    result.ok ? "All profiles pass." : "Some profiles are refused.",
  ].join("\n");

const showSandboxes = (list: SandboxList) =>
  [
    `${list.machine}:`,
    ...list.levels.map((level) =>
      [
        `  ${level.level.padEnd(10)} ${level.available ? `yes${level.mechanism ? ` (${level.mechanism})` : ""}` : "no"}`,
        level.note ? `  ${level.note}` : "",
        level.enable ? `  To enable: ${level.enable}` : "",
      ].join(""),
    ),
  ].join("\n");

const listCommand = Command.make("list", { baseDir: baseDirFlag, json: jsonFlag }).pipe(
  Command.withDescription("Every profile, and what it runs as on this server."),
  Command.withHandler(({ baseDir, json }) =>
    runOperation("list_profiles", {}, baseDir._tag === "Some" ? baseDir.value : undefined).pipe(
      Effect.flatMap((result) =>
        Console.log(json ? encodeJson(result) : showList(result as ProfileList)),
      ),
    ),
  ),
);

const checkCommand = Command.make("check", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  names: Argument.String("name").pipe(
    Argument.withDescription("Only these profiles (default: every one)."),
    Argument.variadic,
  ),
}).pipe(
  Command.withDescription("Check profiles as sync does. Exits 1 when any is refused."),
  Command.withHandler(({ baseDir, json, names }) =>
    runOperation(
      "check_profiles",
      names.length > 0 ? { names } : {},
      baseDir._tag === "Some" ? baseDir.value : undefined,
    ).pipe(
      Effect.flatMap((output) => {
        const result = output as ProfileCheckResult;
        return Console.log(json ? encodeJson(result) : showCheck(result)).pipe(
          Effect.andThen(
            result.ok
              ? Effect.void
              : Effect.sync(() => {
                  process.exitCode = 1;
                }),
          ),
        );
      }),
    ),
  ),
);

const sandboxesCommand = Command.make("sandboxes", { baseDir: baseDirFlag, json: jsonFlag }).pipe(
  Command.withDescription("The sandbox levels this machine can run, and how to enable the others."),
  Command.withHandler(({ baseDir, json }) =>
    runOperation("list_sandboxes", {}, baseDir._tag === "Some" ? baseDir.value : undefined).pipe(
      Effect.flatMap((result) =>
        Console.log(json ? encodeJson(result) : showSandboxes(result as SandboxList)),
      ),
    ),
  ),
);

const PROFILE_TEMPLATE = (
  name: string,
  description: string,
) => `# A Magnesium profile. Edit it, then run \`magnesium-agents check ${name}\`.
name: ${name}
description: ${encodeString(description)}

# Where it runs: machine names the hub pushes it to, or "*" for every one.
# Leave it empty to run it on this server only.
machines: []

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
`;

const newCommand = Command.make("new", {
  baseDir: baseDirFlag,
  name: Argument.String("name").pipe(
    Argument.withDescription("The profile's name: a-z, 0-9 and -."),
  ),
  description: Flag.String("description").pipe(
    Flag.withDescription("One line about what the agent does."),
    Flag.withDefault("A Magnesium agent."),
  ),
}).pipe(
  Command.withDescription("Make a new profile folder to edit."),
  Command.withHandler(({ baseDir, name, description }) =>
    Effect.gen(function* () {
      if (!PROFILE_NAME_PATTERN.test(name)) {
        return yield* new AgentCommandError({
          message: `"${name}" is not a profile name: start with a-z, then a-z, 0-9 and -.`,
        });
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ProfilesConfig.pipe(
        Effect.provide(cliLayer(baseDir._tag === "Some" ? baseDir.value : undefined)),
      );
      const dir = path.join(config.folder, name);
      if (yield* fs.exists(dir)) {
        return yield* new AgentCommandError({ message: `${dir} already exists.` });
      }
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(
        path.join(dir, "profile.yaml"),
        PROFILE_TEMPLATE(name, description),
      );
      yield* fs.writeFileString(
        path.join(dir, "AGENTS.md"),
        `# ${name}\n\n${description}\n\nWrite the agent's role and rules here.\n`,
      );
      yield* Console.log(
        `Made ${dir}.\nEdit profile.yaml and AGENTS.md, then run: magnesium-agents check ${name}\nIt appears in the picker within a minute.`,
      );
    }),
  ),
);

/** `t3 agents`: registered in the server's CLI, so it runs from any release or pack. */
export const agentsCommand = Command.make("agents").pipe(
  Command.withDescription("Magnesium profiles and sandboxes: list, check, sandboxes, new."),
  Command.withSubcommands([listCommand, checkCommand, sandboxesCommand, newCommand]),
);
