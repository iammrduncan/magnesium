import {
  type BackupList,
  type FleetMachine,
  MAGNESIUM_WS_METHODS,
  type ServerBackup,
  UPKEEP_RELEASES_PATH,
  UpkeepError,
  type UpkeepKind,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { urlUnder } from "../forward.ts";
import { HubMachines } from "../hub/HubMachines.ts";
import { HubSpokes } from "../hub/HubSpokes.ts";
import { connectMachine } from "../hub/machineRpc.ts";
import type { MagnesiumRpcClient } from "../rpc/client.ts";
import { Upkeep } from "../upkeep/Upkeep.ts";
import { Fleet } from "./Fleet.ts";

/**
 * Fleet's Update, Roll back, Back up now and Restore for any server (goal 35,
 * D70). The work is each server's own (`Upkeep`); the hub asks for it, sends a
 * machine its build, or changes a pod's image through its gateway, and shows
 * how that goes in the server's Fleet row. A machine is named as the hub knows
 * it; null is the server answering, the hub itself.
 */
export class FleetUpkeep extends Context.Service<
  FleetUpkeep,
  {
    readonly backups: (machine: string | null) => Effect.Effect<BackupList, UpkeepError>;
    readonly backupNow: (machine: string | null) => Effect.Effect<ServerBackup, UpkeepError>;
    readonly restore: (machine: string | null, name: string) => Effect.Effect<void, UpkeepError>;
    readonly rollback: (machine: string | null) => Effect.Effect<void, UpkeepError>;
    /** Puts a server on the hub's build; returns once that is under way. */
    readonly update: (machine: string | null) => Effect.Effect<void, UpkeepError>;
  }
>()("@magnesium/server/fleet/FleetUpkeep") {}

/** A pod's new image may need pulling; a machine's build arrives in minutes. */
const POD_UP_WITHIN = Duration.minutes(10);
const POD_CHECK_EVERY = Duration.seconds(5);
const SEND_TIMEOUT = Duration.minutes(20);

/** A machine's refusal, as its upkeep route answers it. */
const UpkeepErrorBody = Schema.Struct({ error: Schema.String });

export const make = Effect.gen(function* () {
  const upkeep = yield* Upkeep;
  const fleet = yield* Fleet;
  const machines = yield* HubMachines;
  const spokes = yield* HubSpokes;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  /** The hub's own work on each server, one at a time per server. */
  const running = yield* FiberMap.make<string>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (detail: string) => new UpkeepError({ detail });

  const rowOf = (name: string) =>
    Effect.gen(function* () {
      const row = (yield* fleet.machines).find((machine) => machine.name === name);
      if (row === undefined) return yield* fail(`There is no server named ${name} in Fleet.`);
      return row;
    });

  /** Runs `use` on a machine's own RPCs, as the hub. */
  const onMachine = <A>(
    name: string,
    use: (client: MagnesiumRpcClient) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, UpkeepError> =>
    connectMachine(name).pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.provideService(HubMachines, machines),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError((error) =>
        typeof error === "object" && error !== null && "_tag" in error
          ? error._tag === "UpkeepError"
            ? (error as UpkeepError)
            : fail(
                `${name} didn't answer: ${"detail" in error ? String(error.detail) : error._tag}`,
              )
          : fail(`${name} didn't answer.`),
      ),
    );

  const busy = (name: string) =>
    Effect.gen(function* () {
      if (yield* FiberMap.has(running, name)) {
        return yield* fail(`The hub is still working on ${name}.`);
      }
    });

  const setActivity = (machine: string, kind: UpkeepKind, text: string) =>
    Effect.gen(function* () {
      yield* fleet.setUpkeep(machine, { activity: { kind, text, since: yield* now } });
    });
  const finish = (
    machine: string,
    result: {
      readonly kind: UpkeepKind;
      readonly from: string | null;
      readonly to: string | null;
      readonly ok: boolean;
      readonly detail: string;
    },
  ) =>
    Effect.gen(function* () {
      yield* fleet.setUpkeep(machine, {
        activity: null,
        lastResult: { ...result, at: yield* now },
      });
    });

  /** Runs `work` in the background for a server, reporting a failure in its row. */
  const inBackground = (
    machine: string,
    kind: UpkeepKind,
    to: string | null,
    from: string | null,
    work: Effect.Effect<void, UpkeepError>,
  ) =>
    FiberMap.run(
      running,
      machine,
      work.pipe(
        Effect.catch((error) =>
          finish(machine, { kind, from, to, ok: false, detail: error.detail }),
        ),
      ),
    ).pipe(Effect.asVoid);

  /** Changes a pod's build, waits for it to come back on it, and goes back if it doesn't. */
  const podBuild = (row: FleetMachine, kind: UpkeepKind, build: string) =>
    Effect.gen(function* () {
      const name = row.name ?? "";
      const from = row.release;
      yield* setActivity(name, kind, `Changing ${name}'s pod to ${build}: restarting…`);
      yield* spokes
        .changeBuild(name, build, from)
        .pipe(Effect.mapError((error) => fail(error.detail)));
      yield* fleet.setUpkeep(name, { previousRelease: from });
      const cameUp = yield* rowOf(name).pipe(
        Effect.flatMap((current) =>
          current.link === "connected" && current.release === build
            ? Effect.succeed(true)
            : Effect.fail(fail("not yet")),
        ),
        Effect.retry(Schedule.spaced(POD_CHECK_EVERY)),
        Effect.timeoutOption(POD_UP_WITHIN),
      );
      if (cameUp._tag === "Some") {
        return yield* finish(name, {
          kind,
          from,
          to: build,
          ok: true,
          detail: kind === "rollback" ? `Rolled back to ${build}.` : `Updated to ${build}.`,
        });
      }
      if (from === null) {
        return yield* fail(`${build} didn't come up within ${Duration.format(POD_UP_WITHIN)}.`);
      }
      yield* spokes
        .changeBuild(name, from, build)
        .pipe(Effect.mapError((error) => fail(error.detail)));
      yield* fleet.setUpkeep(name, { previousRelease: build });
      yield* finish(name, {
        kind,
        from,
        to: build,
        ok: false,
        detail: `${build} didn't come up within ${Duration.format(POD_UP_WITHIN)}, so ${name} is going back to ${from}.`,
      });
    });

  /** Sends a machine the hub's own build, then has it switch. */
  const sendBuild = (name: string, release: string) =>
    Effect.gen(function* () {
      yield* setActivity(name, "update", `Sending ${release} to ${name}…`);
      const pack = yield* upkeep.packSelf;
      const upstream = yield* machines
        .upstream(name)
        .pipe(Effect.mapError(() => fail(`The hub has no access to ${name}.`)));
      const request = yield* HttpClientRequest.put(
        urlUnder(upstream.url, `${UPKEEP_RELEASES_PATH}/${release}`).toString(),
      ).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${upstream.token}` }),
        HttpClientRequest.bodyFile(pack, { contentType: "application/gzip" }),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((cause) => fail(`Couldn't read the build to send: ${cause}`)),
      );
      yield* httpClient.execute(request).pipe(
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.void
            : HttpClientResponse.schemaBodyJson(UpkeepErrorBody)(response).pipe(
                Effect.flatMap((body) => Effect.fail(fail(body.error))),
                Effect.catchTags({
                  SchemaError: () =>
                    Effect.fail(fail(`${name} refused the build (${response.status}).`)),
                }),
              ),
        ),
        Effect.timeout(SEND_TIMEOUT),
        Effect.mapError((error) =>
          error._tag === "UpkeepError"
            ? error
            : fail(`Couldn't send ${release} to ${name}: ${error._tag}`),
        ),
      );
      yield* setActivity(name, "update", `Updating ${name} to ${release}: restarting…`);
      yield* onMachine(name, (client) => client[MAGNESIUM_WS_METHODS.upkeepUpdate]({ release }));
      yield* fleet.setUpkeep(name, { activity: null });
    });

  const hubRelease = Effect.gen(function* () {
    if (upkeep.release === null) {
      return yield* fail("The hub doesn't run from a release, so it has no build to share.");
    }
    return upkeep.release;
  });

  const notAttached = (name: string, what: string) =>
    Effect.gen(function* () {
      if ((yield* spokes.kindOf(name)) === "attached") {
        return yield* fail(
          `${name} runs inside its workload, whose deploy sets its build, so it can't ${what} from here. Change the Magnesium image in that deploy.`,
        );
      }
    });

  const update = (machine: string | null) =>
    Effect.gen(function* () {
      const release = yield* hubRelease;
      if (machine === null) {
        return yield* fail(
          "Every server follows the hub's build. To put the hub on a new one, deploy it to the hub.",
        );
      }
      yield* busy(machine);
      yield* notAttached(machine, "update");
      const row = yield* rowOf(machine);
      if (row.release === release) return yield* fail(`${machine} is already on ${release}.`);
      if ((yield* spokes.kindOf(machine)) === "pod") {
        return yield* inBackground(
          machine,
          "update",
          release,
          row.release,
          podBuild(row, "update", release),
        );
      }
      if (row.link !== "connected") return yield* fail(`${machine} isn't connected.`);
      if (row.launcher !== "systemd") {
        return yield* fail(
          `Nothing on ${machine} restarts it on another build. Update it with its deploy.`,
        );
      }
      if (row.platform !== null && row.platform !== upkeep.platform) {
        // Another OS or processor can't run the hub's build: it builds the commit itself.
        return yield* onMachine(machine, (client) =>
          client[MAGNESIUM_WS_METHODS.upkeepUpdate]({ release, build: true }),
        );
      }
      yield* inBackground(machine, "update", release, row.release, sendBuild(machine, release));
    });

  const rollback = (machine: string | null) =>
    Effect.gen(function* () {
      if (machine === null) return yield* upkeep.rollback;
      yield* busy(machine);
      yield* notAttached(machine, "roll back");
      const row = yield* rowOf(machine);
      if ((yield* spokes.kindOf(machine)) === "pod") {
        const previous = yield* spokes.previousBuildOf(machine);
        if (previous === null) return yield* fail(`There is no build to take ${machine} back to.`);
        return yield* inBackground(
          machine,
          "rollback",
          previous,
          row.release,
          podBuild(row, "rollback", previous),
        );
      }
      yield* onMachine(machine, (client) => client[MAGNESIUM_WS_METHODS.upkeepRollback]({}));
    });

  return FleetUpkeep.of({
    backups: (machine) =>
      machine === null
        ? upkeep.backups
        : onMachine(machine, (client) => client[MAGNESIUM_WS_METHODS.upkeepBackups]({})),
    backupNow: (machine) =>
      machine === null
        ? upkeep.backupNow
        : onMachine(machine, (client) => client[MAGNESIUM_WS_METHODS.upkeepBackupNow]({})),
    restore: (machine, name) =>
      machine === null
        ? upkeep.restore(name)
        : busy(machine).pipe(
            Effect.andThen(
              onMachine(machine, (client) => client[MAGNESIUM_WS_METHODS.upkeepRestore]({ name })),
            ),
          ),
    rollback,
    update,
  });
});

export const layer = Layer.effect(FleetUpkeep, make);
