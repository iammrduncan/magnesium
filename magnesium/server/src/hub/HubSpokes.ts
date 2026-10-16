import {
  type HubSpoke,
  type HubSpokeApplyInput,
  SpokeError,
  type SpokeRemoveInput,
  type SpokeStatus,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { urlUnder } from "../forward.ts";
import { ServerPorts } from "../ports.ts";
import { GatewayClient } from "./gatewayClient.ts";
import { HubMachines } from "./HubMachines.ts";
import { ModelKeys } from "./ModelKeys.ts";
import { readSpokeRecords, type SpokeRecord, writeSpokeRecords } from "./spokeRecords.ts";

/**
 * The spokes the hub runs through gateways (goal 25, D57). Adding one sends
 * its spec to its gateway with a one-time pairing code and the model keys it
 * gets; once it answers, the hub pairs with it and takes the code back out of
 * its Secret. A machine moved into Kubernetes keeps the hub's access: its
 * state moves with it, so it needs no pairing.
 */
export class HubSpokes extends Context.Service<
  HubSpokes,
  {
    readonly list: Effect.Effect<ReadonlyArray<HubSpoke>, SpokeError>;
    readonly apply: (input: HubSpokeApplyInput) => Effect.Effect<HubSpoke, SpokeError>;
    readonly remove: (input: SpokeRemoveInput) => Effect.Effect<void, SpokeError>;
    /** The hub's machines that answer for their spokes. */
    readonly gateways: Effect.Effect<ReadonlyArray<string>, SpokeError>;
  }
>()("@magnesium/server/hub/HubSpokes") {}

/** How long a new spoke may take to come up and pair: an image pull and a first start. */
const PAIR_RETRIES = 120;
const PAIR_EVERY = Duration.seconds(5);
/** A machine that hasn't answered for its spokes by then isn't a gateway the hub can use now. */
const GATEWAY_PROBE = Duration.seconds(4);

export const make = Effect.gen(function* () {
  const ports = yield* ServerPorts;
  const machines = yield* HubMachines;
  const gateways = yield* GatewayClient;
  const keys = yield* ModelKeys;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pairings = yield* FiberMap.make<string>();

  const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const records = withFiles(readSpokeRecords(ports.baseDir));
  const save = (next: ReadonlyArray<SpokeRecord>) =>
    withFiles(writeSpokeRecords(ports.baseDir, next)).pipe(
      Effect.mapError(() => new SpokeError({ detail: "Could not save the hub's spokes." })),
    );
  const hasAccess = (name: string) =>
    machines.upstream(name).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  /** A code nobody types: 32 random hex characters. */
  const newCode = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => uuid.replaceAll("-", "").toUpperCase()),
    Effect.orDie,
  );

  /** Waits for a new spoke to answer, pairs with it, then takes the code out of its Secret. */
  const pairWhenUp = (
    record: SpokeRecord,
    code: string,
    keyValues: Readonly<Record<string, string>>,
  ) =>
    Effect.gen(function* () {
      yield* machines.giveAccess(record.name, { pairingCode: code }).pipe(
        Effect.retry({
          schedule: Schedule.spaced(PAIR_EVERY),
          times: PAIR_RETRIES,
          // Not up yet; a refused code won't get better.
          while: (error) =>
            error._tag === "HubMachineAccessError" && error.detail.startsWith("Could not reach"),
        }),
      );
      yield* gateways.apply(record.gateway, {
        spec: record.spec,
        secrets: { pairingCode: null, keys: keyValues },
      });
      yield* Effect.logInfo("The hub paired with a new spoke.", { name: record.name });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("The hub could not pair with a new spoke.", {
          name: record.name,
          error: error._tag,
        }),
      ),
    );

  const apply = Effect.fn("HubSpokes.apply")(function* (input: HubSpokeApplyInput) {
    const { gateway, spec } = input;
    const known = yield* records;
    if (spec.name === gateway || known.some((record) => record.name === gateway)) {
      return yield* new SpokeError({ detail: `${gateway} isn't a gateway the hub can use.` });
    }
    const gatewayUpstream = yield* machines
      .upstream(gateway)
      .pipe(
        Effect.mapError(
          () => new SpokeError({ detail: `The hub has no access to the gateway ${gateway}.` }),
        ),
      );
    const paired = yield* hasAccess(spec.name);
    const keyValues = yield* keys.values(input.keys);
    const code = paired ? null : yield* newCode;
    const status = yield* gateways.apply(gateway, {
      spec,
      secrets: { pairingCode: code, keys: keyValues },
    });
    const record: SpokeRecord = {
      name: spec.name,
      gateway,
      url: urlUnder(gatewayUpstream.url, `/spokes/${spec.name}`).toString(),
      spec,
      keys: input.keys,
    };
    yield* save([...known.filter((other) => other.name !== spec.name), record]);
    yield* machines.refresh(spec.name);
    if (code !== null && spec.replicas === 1) {
      yield* FiberMap.run(pairings, spec.name, pairWhenUp(record, code, keyValues));
    }
    return {
      ...record,
      status,
      paired,
      detail: paired ? null : "The hub pairs with it once it is up.",
    } satisfies HubSpoke;
  });

  const remove = Effect.fn("HubSpokes.remove")(function* (input: SpokeRemoveInput) {
    const known = yield* records;
    const record = known.find((other) => other.name === input.name);
    if (record === undefined) {
      return yield* new SpokeError({ detail: `The hub runs no spoke named ${input.name}.` });
    }
    yield* gateways.remove(record.gateway, input);
    yield* FiberMap.remove(pairings, input.name);
    // Its home gone, the hub's token for it is useless; kept, the spoke can come back.
    if (!input.keepVolume) yield* machines.removeAccess(input.name).pipe(Effect.ignore);
    yield* save(known.filter((other) => other.name !== input.name));
    yield* machines.refresh(input.name);
  });

  const list = Effect.gen(function* () {
    const known = yield* records;
    const byGateway = new Map<string, Map<string, SpokeStatus> | string>();
    for (const gateway of new Set(known.map((record) => record.gateway))) {
      const statuses = yield* gateways.list(gateway).pipe(
        Effect.map((all) => new Map(all.map((status) => [status.name, status]))),
        Effect.catch((error) => Effect.succeed(error.detail)),
      );
      byGateway.set(gateway, statuses);
    }
    return yield* Effect.forEach(known, (record) =>
      Effect.gen(function* () {
        const statuses = byGateway.get(record.gateway);
        const paired = yield* hasAccess(record.name);
        return {
          ...record,
          status: typeof statuses === "string" ? null : (statuses?.get(record.name) ?? null),
          paired,
          detail:
            typeof statuses === "string"
              ? statuses
              : paired
                ? null
                : "The hub pairs with it once it is up.",
        } satisfies HubSpoke;
      }),
    );
  });

  const gateways_ = Effect.gen(function* () {
    const spokeNames = new Set((yield* records).map((record) => record.name));
    const names = (yield* machines.names).filter((name) => !spokeNames.has(name));
    const answered = yield* Effect.forEach(
      names,
      (name) =>
        gateways.list(name).pipe(
          Effect.timeout(GATEWAY_PROBE),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: "unbounded" },
    );
    return names.filter((_, index) => answered[index]);
  });

  return HubSpokes.of({ list, apply, remove, gateways: gateways_ });
});

export const layer = Layer.effect(HubSpokes, make);
