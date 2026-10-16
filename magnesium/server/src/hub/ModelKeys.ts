import { SpokeError } from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerPorts } from "../ports.ts";

/**
 * Model keys the hub holds for Magnesium as a whole (D57): one key per model
 * gateway or provider, by the environment name agents read it from, such as
 * `LITELLM_API_KEY`. They live in the hub's secret store and leave it only
 * for a spoke's Secret, by name (goal 25). Values are never listed.
 */
export class ModelKeys extends Context.Service<
  ModelKeys,
  {
    readonly names: Effect.Effect<ReadonlyArray<string>, SpokeError>;
    /** The values of `names`; a name the hub doesn't hold fails, naming it. */
    readonly values: (
      names: ReadonlyArray<string>,
    ) => Effect.Effect<Readonly<Record<string, string>>, SpokeError>;
    readonly set: (name: string, value: string) => Effect.Effect<void, SpokeError>;
    readonly remove: (name: string) => Effect.Effect<void, SpokeError>;
  }
>()("@magnesium/server/hub/ModelKeys") {}

const SECRET = "magnesium-model-keys";
const KeysJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeKeys = Schema.decodeUnknownEffect(KeysJson);
const encodeKeys = Schema.encodeEffect(KeysJson);

export const make = Effect.gen(function* () {
  const ports = yield* ServerPorts;
  const failed = (detail: string) => () => new SpokeError({ detail });

  const read = Effect.suspend(() => ports.getSecret(SECRET)).pipe(
    Effect.mapError(failed("Could not read the hub's model keys.")),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed({} as Readonly<Record<string, string>>),
        onSome: (bytes) =>
          decodeKeys(new TextDecoder().decode(bytes)).pipe(
            Effect.mapError(failed("The hub's model keys are unreadable.")),
          ),
      }),
    ),
  );
  const write = (keys: Readonly<Record<string, string>>) =>
    encodeKeys(keys).pipe(
      Effect.orDie,
      Effect.flatMap((json) => ports.setSecret(SECRET, new TextEncoder().encode(json))),
      Effect.mapError(failed("Could not save the hub's model keys.")),
    );

  return ModelKeys.of({
    names: read.pipe(Effect.map((keys) => Object.keys(keys).toSorted())),
    values: (names) =>
      read.pipe(
        Effect.flatMap((keys) => {
          const missing = names.filter((name) => keys[name] === undefined);
          return missing.length > 0
            ? Effect.fail(
                new SpokeError({ detail: `The hub holds no key named ${missing.join(", ")}.` }),
              )
            : Effect.succeed(Object.fromEntries(names.map((name) => [name, keys[name]!])));
        }),
      ),
    set: (name, value) => read.pipe(Effect.flatMap((keys) => write({ ...keys, [name]: value }))),
    remove: (name) =>
      read.pipe(
        Effect.flatMap((keys) => {
          const { [name]: _gone, ...rest } = keys;
          return write(rest);
        }),
      ),
  });
});

export const layer = Layer.effect(ModelKeys, make);
