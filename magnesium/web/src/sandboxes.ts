import {
  AGENTS_API_PATH,
  HUB_ENVIRONMENT_ROUTE_PREFIX,
  hubMachineSandboxesPath,
  parseNativeTwinInstanceId,
  parseProfileInstanceId,
  type SandboxLevel,
  SandboxList,
  nativeTwinInstanceId,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

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

export interface InstanceSandbox {
  readonly level: SandboxLevel;
  /** Instances a thread can switch between: one profile and harness, or one stock instance. */
  readonly group: string;
  /** The profile's name, or null for a stock instance. */
  readonly profile: string | null;
}

/** The level and group of an instance, from its id and its siblings' ids. Null: not one of ours. */
export function instanceSandbox(
  instanceId: string,
  allInstanceIds: ReadonlyArray<string>,
): InstanceSandbox | null {
  const profile = parseProfileInstanceId(instanceId);
  if (profile !== null) {
    return {
      level: profile.level,
      group: `profile:${profile.profile}:${profile.harness}`,
      profile: profile.profile,
    };
  }
  const twinOf = parseNativeTwinInstanceId(instanceId);
  if (twinOf !== null) return { level: "native", group: twinOf, profile: null };
  // Profile sync fences a stock instance and gives it a native twin.
  return allInstanceIds.includes(nativeTwinInstanceId(instanceId))
    ? { level: "fenced", group: instanceId, profile: null }
    : null;
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
