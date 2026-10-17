import {
  type HubAttached,
  type HubAttachInput,
  type HubDetachInput,
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
import {
  type AttachedRecord,
  readAttachedRecords,
  readSpokeRecords,
  type SpokeRecord,
  writeAttachedRecords,
  writeSpokeRecords,
} from "./spokeRecords.ts";

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
    /** Machines attached inside workloads' pods (D59): reached, never started or stopped. */
    readonly attached: Effect.Effect<ReadonlyArray<HubAttached>, SpokeError>;
    readonly attach: (input: HubAttachInput) => Effect.Effect<HubAttached, SpokeError>;
    readonly detach: (input: HubDetachInput) => Effect.Effect<void, SpokeError>;
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
  const attachedRecords = withFiles(readAttachedRecords(ports.baseDir));
  const saveAttached = (next: ReadonlyArray<AttachedRecord>) =>
    withFiles(writeAttachedRecords(ports.baseDir, next)).pipe(
      Effect.mapError(
        () => new SpokeError({ detail: "Could not save the hub's attached machines." }),
      ),
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

  /** Pairs with a machine using its one-time code, once it answers. */
  const pairWithCode = (name: string, code: string) =>
    machines.giveAccess(name, { pairingCode: code }).pipe(
      Effect.retry({
        schedule: Schedule.spaced(PAIR_EVERY),
        times: PAIR_RETRIES,
        // Not up yet; a refused code won't get better.
        while: (error) =>
          error._tag === "HubMachineAccessError" && error.detail.startsWith("Could not reach"),
      }),
    );

  /** Waits for a new spoke to answer, pairs with it, then takes the code out of its Secret. */
  const pairWhenUp = (
    record: SpokeRecord,
    code: string,
    keyValues: Readonly<Record<string, string>>,
  ) =>
    Effect.gen(function* () {
      yield* pairWithCode(record.name, code);
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

  /** Where the hub reaches a machine behind `gateway`, or why it can't. */
  const urlThrough = Effect.fn("HubSpokes.urlThrough")(function* (gateway: string, name: string) {
    const behindGateways = [...(yield* records), ...(yield* attachedRecords)];
    if (name === gateway || behindGateways.some((record) => record.name === gateway)) {
      return yield* new SpokeError({ detail: `${gateway} isn't a gateway the hub can use.` });
    }
    const gatewayUpstream = yield* machines
      .upstream(gateway)
      .pipe(
        Effect.mapError(
          () => new SpokeError({ detail: `The hub has no access to the gateway ${gateway}.` }),
        ),
      );
    return urlUnder(gatewayUpstream.url, `/spokes/${name}`).toString();
  });

  const apply = Effect.fn("HubSpokes.apply")(function* (input: HubSpokeApplyInput) {
    const { gateway, spec } = input;
    const known = yield* records;
    if ((yield* attachedRecords).some((record) => record.name === spec.name)) {
      return yield* new SpokeError({
        detail: `${spec.name} is attached to a workload; detach it first.`,
      });
    }
    const url = yield* urlThrough(gateway, spec.name);
    const paired = yield* hasAccess(spec.name);
    const keyValues = yield* keys.values(input.keys);
    const code = paired ? null : yield* newCode;
    const status = yield* gateways.apply(gateway, {
      spec,
      secrets: { pairingCode: code, keys: keyValues },
    });
    const record: SpokeRecord = { name: spec.name, gateway, url, spec, keys: input.keys };
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
        const status = typeof statuses === "string" ? null : (statuses?.get(record.name) ?? null);
        const paired = yield* hasAccess(record.name);
        return {
          ...record,
          status,
          paired,
          detail:
            typeof statuses === "string"
              ? statuses
              : status === null
                ? "Nothing runs for it in the cluster. Start it or change its build to apply it again."
                : paired
                  ? null
                  : "The hub pairs with it once it is up.",
        } satisfies HubSpoke;
      }),
    );
  });

  const gateways_ = Effect.gen(function* () {
    const spokeNames = new Set(
      [...(yield* records), ...(yield* attachedRecords)].map((record) => record.name),
    );
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

  const attached = Effect.gen(function* () {
    return yield* Effect.forEach(yield* attachedRecords, (record) =>
      hasAccess(record.name).pipe(
        Effect.map((paired): HubAttached => ({
          name: record.name,
          gateway: record.gateway,
          paired,
          detail: paired ? null : "Not paired yet: the hub pairs with its code once it answers.",
        })),
      ),
    );
  });

  const attach = Effect.fn("HubSpokes.attach")(function* (input: HubAttachInput) {
    const { name, gateway } = input;
    if ((yield* records).some((record) => record.name === name)) {
      return yield* new SpokeError({
        detail: `The hub runs a spoke named ${name}. Remove it first, keeping its home.`,
      });
    }
    const url = yield* urlThrough(gateway, name);
    const known = yield* attachedRecords;
    yield* saveAttached([...known.filter((other) => other.name !== name), { name, gateway, url }]);
    yield* machines.refresh(name);
    const paired = yield* hasAccess(name);
    if (!paired && input.pairingCode !== null) {
      yield* FiberMap.run(
        pairings,
        name,
        pairWithCode(name, input.pairingCode).pipe(
          Effect.tap(() => Effect.logInfo("The hub paired with an attached machine.", { name })),
          Effect.catch((error) =>
            Effect.logWarning("The hub could not pair with an attached machine.", {
              name,
              error: error._tag,
            }),
          ),
        ),
      );
    }
    return {
      name,
      gateway,
      paired,
      detail: paired
        ? null
        : input.pairingCode === null
          ? "The hub has no access to it: attach it again with its pairing code."
          : "The hub pairs with it once it answers.",
    } satisfies HubAttached;
  });

  const detach = Effect.fn("HubSpokes.detach")(function* (input: HubDetachInput) {
    const known = yield* attachedRecords;
    if (!known.some((record) => record.name === input.name)) {
      return yield* new SpokeError({ detail: `No machine named ${input.name} is attached.` });
    }
    yield* FiberMap.remove(pairings, input.name);
    // The way back out of attach: the record and the hub's access both go.
    yield* machines.removeAccess(input.name).pipe(Effect.ignore);
    yield* saveAttached(known.filter((record) => record.name !== input.name));
    yield* machines.refresh(input.name);
  });

  return HubSpokes.of({ list, apply, remove, gateways: gateways_, attached, attach, detach });
});

export const layer = Layer.effect(HubSpokes, make);
