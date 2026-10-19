import {
  AGENTS_API_PATH,
  HUB_ENVIRONMENT_ROUTE_PREFIX,
  hubMachineSandboxesPath,
  instanceSandbox,
  type InstanceSandbox,
  type SandboxLevel,
  SandboxList,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { hubMachineNameOf } from "./hubMachines.ts";

/**
 * Profiles and sandbox levels in the picker (goal 03). Every agent runs at a
 * level: `fenced` by default, `container` where the machine has Podman,
 * `native` only by choice. A profile or stock instance's levels are sibling
 * provider instances sharing one home, so a thread switches level by switching
 * instance, and keeps its session. Their ids say which is which, so the picker
 * needs no request to show the chip; the machine's level list (what is missing,
 * and how to add it) loads when the chip opens.
 */

// The level an instance runs at lives in the contracts, where Home's server reads it too.
export { instanceSandbox, type InstanceSandbox };

/**
 * Where an approval's command runs, as its card says it (goal 34): "Runs on
 * cpu-host-1 in the container sandbox", or only the machine when its level
 * isn't known.
 */
export function whereItRuns(machine: string, level: SandboxLevel | null | undefined): string {
  return level == null ? `Runs on ${machine}` : `Runs on ${machine} in the ${level} sandbox`;
}

export interface SandboxSibling {
  readonly instanceId: string;
  readonly level: SandboxLevel;
}

const LEVEL_ORDER: ReadonlyArray<SandboxLevel> = ["fenced", "container", "native", "microvm"];

/** The levels this instance's thread can switch to, the default first. */
export function sandboxSiblings(
  instanceId: string,
  allInstanceIds: ReadonlyArray<string>,
): ReadonlyArray<SandboxSibling> {
  const own = instanceSandbox(instanceId, allInstanceIds);
  if (own === null) return [];
  return allInstanceIds
    .flatMap((id) => {
      const sandbox = instanceSandbox(id, allInstanceIds);
      return sandbox !== null && sandbox.group === own.group
        ? [{ instanceId: id, level: sandbox.level }]
        : [];
    })
    .toSorted((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** A profile instance's display name without its level suffix ("scratch-a · native"). */
export function profileDisplayName(displayName: string): string {
  return displayName.replace(/ · (fenced|container|native|microvm)$/, "");
}

/**
 * Where an environment's level list is: the hub's own agents API for the hub
 * (or a single box), and the hub's machine route for a machine it carries.
 */
export function sandboxesUrl(httpBaseUrl: string): string {
  const machine = hubMachineNameOf({ httpBaseUrl });
  if (machine !== null) {
    const base = new URL(httpBaseUrl);
    const hubRoot = base.pathname.slice(0, base.pathname.indexOf(HUB_ENVIRONMENT_ROUTE_PREFIX));
    return new URL(`${hubRoot}${hubMachineSandboxesPath(machine)}`, base.origin).toString();
  }
  return new URL(`${AGENTS_API_PATH}/sandboxes`, httpBaseUrl).toString();
}

export class SandboxesRequestError extends Schema.TaggedError<SandboxesRequestError>()(
  "SandboxesRequestError",
  { message: Schema.String },
) {}

/** The levels a machine can run, same-origin with the hub so the session cookie goes along. */
export const fetchSandboxes = (httpBaseUrl: string) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(HttpClientRequest.get(sandboxesUrl(httpBaseUrl))),
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SandboxList)),
    Effect.mapError(
      (cause) =>
        new SandboxesRequestError({ message: `Could not load the sandboxes: ${cause.message}` }),
    ),
  );
