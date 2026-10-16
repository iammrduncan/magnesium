import {
  type HubMachine,
  type HubMachineAccess,
  type HubMachineAccessInput,
  type HubMachineList,
  HubMachineName,
} from "@magnesium/contracts";
import { AuthAccessWriteScope, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerPorts, type ServerPortError } from "../ports.ts";
import * as MachineApi from "./machineApi.ts";
import { readSpokeRecords } from "./spokeRecords.ts";

/**
 * The machines this hub carries, and the token it holds for each (D14: tokens
 * stay on the hub). The list comes from deploy config, `<T3CODE_HOME>/hub-machines.json`,
 * written by the `magnesium_hub` Ansible role; a server without that file is not a hub.
 */

export const HUB_MACHINES_CONFIG_FILE = "hub-machines.json";

const HubMachinesConfig = Schema.Struct({
  machines: Schema.Array(
    Schema.Struct({
      name: HubMachineName,
      /** The machine server's origin as the hub reaches it: its loopback relay. */
      url: Schema.String,
    }),
  ),
});
type HubMachineConfig = (typeof HubMachinesConfig.Type)["machines"][number];
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HubMachinesConfig));

const StoredAccess = Schema.Struct({
  token: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
  expiresAt: Schema.String,
});
type StoredAccess = typeof StoredAccess.Type;
const StoredAccessJson = Schema.fromJsonString(StoredAccess);
const decodeStoredAccess = Schema.decodeUnknownEffect(StoredAccessJson);
const encodeStoredAccess = Schema.encodeEffect(StoredAccessJson);

const secretName = (name: string) => `magnesium-hub-machine-${name}`;

/** Renew a machine token this long before it expires (sessions last 30 days). */
const RENEW_BEFORE = Duration.days(7);
const RENEW_EVERY = Duration.hours(1);
/** Clients poll the list; probe each machine at most this often. */
const PROBE_TTL = Duration.seconds(20);

export class HubMachineNotFoundError extends Schema.TaggedError<HubMachineNotFoundError>()(
  "HubMachineNotFoundError",
  { name: Schema.String },
) {}

export class HubMachineAccessError extends Schema.TaggedError<HubMachineAccessError>()(
  "HubMachineAccessError",
  { name: Schema.String, detail: Schema.String },
) {}

export interface HubMachineUpstream {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

interface Probe {
  readonly checkedAt: number;
  readonly online: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly label: string | null;
}

export class HubMachines extends Context.Service<
  HubMachines,
  {
    readonly list: Effect.Effect<HubMachineList, ServerPortError>;
    readonly giveAccess: (
      name: string,
      input: HubMachineAccessInput,
    ) => Effect.Effect<
      HubMachine,
      HubMachineNotFoundError | HubMachineAccessError | ServerPortError
    >;
    readonly removeAccess: (
      name: string,
    ) => Effect.Effect<void, HubMachineNotFoundError | ServerPortError>;
    /** Where to send a proxied request, with the token to send it with. */
    readonly upstream: (
      name: string,
    ) => Effect.Effect<
      HubMachineUpstream,
      HubMachineNotFoundError | HubMachineAccessError | ServerPortError
    >;
    /** The machine refused the hub's token; show the machine as needing access. */
    readonly markRejected: (name: string) => Effect.Effect<void>;
    readonly renewDue: Effect.Effect<void>;
    /** The machines in the config, by name; read fresh each time. */
    readonly names: Effect.Effect<ReadonlyArray<string>>;
    /** The name of each machine whose access was just given or removed. */
    readonly accessChanged: Stream.Stream<string>;
    /** Forget what the hub last saw of a machine and reconnect to it, as when its address changed. */
    readonly refresh: (name: string) => Effect.Effect<void>;
  }
>()("@magnesium/server/hub/HubMachines") {}

export const make = Effect.gen(function* () {
  const ports = yield* ServerPorts;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const configPath = path.join(ports.baseDir, HUB_MACHINES_CONFIG_FILE);
  const probes = yield* Ref.make(new Map<string, Probe>());
  const rejected = yield* Ref.make(new Set<string>());
  const accessChanged = yield* PubSub.unbounded<string>();

  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.provideService(effect, HttpClient.HttpClient, httpClient);

  // Missing or unreadable config means no machines: this server is not a hub.
  const readDeployConfig = fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeConfig),
    Effect.map((config) => config.machines),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed([] as ReadonlyArray<HubMachineConfig>)
        : Effect.logWarning("Could not read the hub's machine list.", { configPath, error }).pipe(
            Effect.as([] as ReadonlyArray<HubMachineConfig>),
          ),
    ),
  );

  // The hub's own spokes (goal 25) join the deploy config's machines, replacing one of the same name.
  const readConfig = Effect.all([
    readDeployConfig,
    readSpokeRecords(ports.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    ),
  ]).pipe(
    Effect.map(([machines, spokes]): ReadonlyArray<HubMachineConfig> => {
      const spokeNames = new Set(spokes.map((spoke) => spoke.name));
      return [
        ...machines.filter((machine) => !spokeNames.has(machine.name)),
        ...spokes.map((spoke) => ({ name: spoke.name, url: spoke.url })),
      ];
    }),
  );

  const findMachine = (name: string) =>
    readConfig.pipe(
      Effect.flatMap((machines) => {
        const machine = machines.find((candidate) => candidate.name === name);
        return machine === undefined
          ? Effect.fail(new HubMachineNotFoundError({ name }))
          : Effect.succeed(machine);
      }),
    );

  const readStored = (name: string) =>
    ports.getSecret(secretName(name)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) =>
            decodeStoredAccess(new TextDecoder().decode(bytes)).pipe(
              Effect.asSome,
              Effect.catch((error) =>
                Effect.logWarning("Ignoring an unreadable hub machine token.", {
                  name,
                  error: error.message,
                }).pipe(Effect.as(Option.none<StoredAccess>())),
              ),
            ),
        }),
      ),
    );

  const writeStored = (name: string, stored: StoredAccess) =>
    encodeStoredAccess(stored).pipe(
      Effect.orDie,
      Effect.flatMap((json) => ports.setSecret(secretName(name), new TextEncoder().encode(json))),
    );

  const probe = Effect.fn("HubMachines.probe")(function* (machine: HubMachineConfig) {
    const now = yield* DateTime.now;
    const cached = (yield* Ref.get(probes)).get(machine.name);
    if (
      cached !== undefined &&
      DateTime.toEpochMillis(now) - cached.checkedAt < Duration.toMillis(PROBE_TTL)
    ) {
      return cached;
    }
    const descriptor = yield* withHttp(MachineApi.fetchDescriptor(machine.url)).pipe(Effect.option);
    const next: Probe = Option.match(descriptor, {
      onNone: () => ({
        checkedAt: DateTime.toEpochMillis(now),
        online: false,
        environmentId: cached?.environmentId ?? null,
        label: cached?.label ?? null,
      }),
      onSome: (value) => ({
        checkedAt: DateTime.toEpochMillis(now),
        online: true,
        environmentId: value.environmentId,
        label: value.label,
      }),
    });
    yield* Ref.update(probes, (current) => new Map(current).set(machine.name, next));
    return next;
  });

  const accessOf = (
    name: string,
    stored: StoredAccess | undefined,
    probed: Probe,
    now: DateTime.Utc,
    rejectedNames: ReadonlySet<string>,
  ): HubMachineAccess => {
    if (stored === undefined) return "missing";
    if (rejectedNames.has(name)) return "expired";
    // A reinstalled machine has a new identity; the old token is useless there.
    if (probed.environmentId !== null && probed.environmentId !== stored.environmentId) {
      return "expired";
    }
    const expiresAt = DateTime.make(stored.expiresAt);
    if (Option.isNone(expiresAt) || DateTime.isLessThanOrEqualTo(expiresAt.value, now)) {
      return "expired";
    }
    return "ready";
  };

  const describe = Effect.fn("HubMachines.describe")(function* (machine: HubMachineConfig) {
    const [stored, probed, now, rejectedNames] = yield* Effect.all([
      readStored(machine.name),
      probe(machine),
      DateTime.now,
      Ref.get(rejected),
    ]);
    const storedValue = Option.getOrUndefined(stored);
    return {
      name: machine.name,
      label: probed.label ?? storedValue?.label ?? machine.name,
      environmentId: probed.environmentId ?? storedValue?.environmentId ?? null,
      access: accessOf(machine.name, storedValue, probed, now, rejectedNames),
      accessExpiresAt: storedValue?.expiresAt ?? null,
      online: probed.online,
    } satisfies HubMachine;
  });

  const list = readConfig.pipe(
    Effect.flatMap((machines) => Effect.forEach(machines, describe, { concurrency: "unbounded" })),
    Effect.map((machines): HubMachineList => ({ machines })),
    Effect.withSpan("HubMachines.list"),
  );

  const giveAccess = Effect.fn("HubMachines.giveAccess")(function* (
    name: string,
    input: HubMachineAccessInput,
  ) {
    const machine = yield* findMachine(name);
    const refused = (detail: string) => new HubMachineAccessError({ name, detail });
    const unreachable = (error: MachineApi.MachineRequestError) =>
      refused(
        error.rejected
          ? "The machine did not accept that credential."
          : `Could not reach ${name}: ${error.detail}`,
      );

    const granted = yield* "bearerToken" in input
      ? withHttp(MachineApi.fetchSession(machine.url, input.bearerToken)).pipe(
          Effect.mapError(unreachable),
          Effect.flatMap((session) =>
            session.authenticated && session.expiresAt !== undefined
              ? Effect.succeed({
                  token: input.bearerToken,
                  scopes: session.scopes ?? [],
                  expiresAt: session.expiresAt,
                })
              : Effect.fail(refused("The machine did not accept that token.")),
          ),
        )
      : withHttp(MachineApi.exchangePairingCode(machine.url, input.pairingCode)).pipe(
          Effect.mapError(unreachable),
          Effect.flatMap((issued) =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                token: issued.access_token,
                scopes: issued.scope.split(" "),
                expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
              })),
            ),
          ),
        );
    // The hub reads and operates threads; it never holds an admin session (goal 04).
    if (granted.scopes.includes(AuthAccessWriteScope)) {
      return yield* refused("That credential has admin rights; the hub keeps only standard ones.");
    }
    const descriptor = yield* withHttp(MachineApi.fetchDescriptor(machine.url)).pipe(
      Effect.mapError(unreachable),
    );
    yield* writeStored(name, {
      token: granted.token,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      expiresAt: DateTime.formatIso(granted.expiresAt),
    });
    yield* Ref.update(rejected, (current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    yield* Ref.update(probes, (current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    yield* Effect.logInfo("The hub has access to a machine.", { name });
    yield* PubSub.publish(accessChanged, name);
    return yield* describe(machine);
  });

  const removeAccess = Effect.fn("HubMachines.removeAccess")(function* (name: string) {
    yield* findMachine(name);
    yield* ports.removeSecret(secretName(name));
    yield* Ref.update(rejected, (current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    yield* Effect.logInfo("The hub no longer has access to a machine.", { name });
    yield* PubSub.publish(accessChanged, name);
  });

  const upstream = Effect.fn("HubMachines.upstream")(function* (name: string) {
    const machine = yield* findMachine(name);
    const stored = yield* readStored(name);
    if (Option.isNone(stored)) {
      return yield* new HubMachineAccessError({ name, detail: "The hub has no access to it yet." });
    }
    return { name, url: machine.url, token: stored.value.token } satisfies HubMachineUpstream;
  });

  const markRejected = (name: string) =>
    Ref.update(rejected, (current) => new Set(current).add(name));

  const renewOne = Effect.fn("HubMachines.renewOne")(function* (machine: HubMachineConfig) {
    const stored = yield* readStored(machine.name);
    if (Option.isNone(stored)) return;
    const expiresAt = DateTime.make(stored.value.expiresAt);
    const now = yield* DateTime.now;
    if (
      Option.isNone(expiresAt) ||
      DateTime.isLessThanOrEqualTo(expiresAt.value, now) ||
      DateTime.isGreaterThan(expiresAt.value, DateTime.addDuration(now, RENEW_BEFORE))
    ) {
      return;
    }
    const renewed = yield* withHttp(MachineApi.renewSession(machine.url, stored.value.token));
    yield* writeStored(machine.name, {
      ...stored.value,
      token: renewed.token,
      expiresAt: renewed.expiresAt,
    });
    yield* Effect.logInfo("Renewed the hub's token for a machine.", { name: machine.name });
  });

  const renewDue = readConfig.pipe(
    Effect.flatMap((machines) =>
      Effect.forEach(
        machines,
        (machine) =>
          renewOne(machine).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not renew the hub's token for a machine.", {
                name: machine.name,
                error: error.message,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.withSpan("HubMachines.renewDue"),
  );

  return HubMachines.of({
    list,
    giveAccess,
    removeAccess,
    upstream,
    markRejected,
    renewDue,
    names: readConfig.pipe(Effect.map((machines) => machines.map((machine) => machine.name))),
    accessChanged: Stream.fromPubSub(accessChanged),
    refresh: (name) =>
      Effect.gen(function* () {
        yield* Ref.update(probes, (current) => {
          const next = new Map(current);
          next.delete(name);
          return next;
        });
        yield* Ref.update(rejected, (current) => {
          const next = new Set(current);
          next.delete(name);
          return next;
        });
        yield* PubSub.publish(accessChanged, name);
      }),
  });
});

export const layer = Layer.effect(HubMachines, make);

/** Renews the hub's machine tokens a week before they run out, so nobody pairs a machine twice. */
export const renewalLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const machines = yield* HubMachines;
    yield* machines.renewDue.pipe(Effect.repeat(Schedule.spaced(RENEW_EVERY)), Effect.forkScoped);
  }),
);
