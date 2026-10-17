import {
  type FleetMachine,
  type HubAttached,
  type HubAttachInput,
  type HubSpoke,
  type HubSpokeApplyInput,
  MAGNESIUM_WS_METHODS,
  type SpokeRemoveInput,
  type SpokeSpec,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";

import { describePlace } from "./fleet.ts";
import { HubRequestError } from "./hubMachines.ts";
import { connectMagnesium, type MagnesiumRpcClient, magnesiumSocketUrl } from "./rpc.ts";

/**
 * The hub's spokes in Kubernetes and its model keys (goal 25), for Settings →
 * Connections. Each call opens the hub's route for itself: these are admin
 * actions, taken now and then, not a live view.
 */

/** A refusal from the hub, in a sentence the page can show. */
const sentenceOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "SpokeError" && "detail" in error && typeof error.detail === "string") {
      return error.detail;
    }
    if (error._tag === "EnvironmentAuthorizationError") {
      return "This needs an admin session on the hub.";
    }
  }
  return "Could not reach the hub.";
};

/** One call on the hub's route, over a socket opened for it and closed after. */
export const callHub = <A, E>(
  pageUrl: string,
  use: (client: MagnesiumRpcClient) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    connectMagnesium(magnesiumSocketUrl(pageUrl)).pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.mapError((error) => new HubRequestError({ status: null, message: sentenceOf(error) })),
    ),
  );

export const listHubSpokes = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubSpokesList]());

export const applyHubSpoke = (pageUrl: string, input: HubSpokeApplyInput) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubSpokesApply](input));

export const removeHubSpoke = (pageUrl: string, input: SpokeRemoveInput) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubSpokesRemove](input));

/** The hub's machines that are gateways. */
export const listGateways = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubSpokesGateways]());

/** Machines attached inside workloads' pods (D59). */
export const listAttached = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubAttachedList]());

export const attachMachine = (pageUrl: string, input: HubAttachInput) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubAttach](input));

export const detachMachine = (pageUrl: string, name: string, keepAccess: boolean) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.hubDetach]({ name, keepAccess }));

/** An attached machine's row: how the hub reaches it, and whether it can yet. */
export const describeAttached = (machine: HubAttached): string => {
  const where =
    machine.workload === null
      ? `through ${machine.gateway}`
      : `in ${machine.workload} · through ${machine.gateway}`;
  const place = where.charAt(0).toUpperCase() + where.slice(1);
  if (machine.detail !== null) return `${machine.detail} · ${where}`;
  return machine.paired ? place : `Not paired yet · ${where}`;
};

/**
 * What the Attach form sends, or what's wrong with it. The code is optional:
 * a machine moved in from a spoke keeps the hub's access.
 */
export const attachFromForm = (form: {
  readonly name: string;
  readonly gateway: string;
  readonly pairingCode: string;
}): HubAttachInput | { readonly problem: string } => {
  const name = form.name.trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$/.test(name)) {
    return { problem: "A name is lowercase letters, digits and dashes, as its Service has." };
  }
  if (form.gateway === "") return { problem: "Pick its gateway." };
  const code = form.pairingCode.trim();
  if (code !== "" && code.length < 16) {
    return { problem: "A pairing code is at least 16 characters." };
  }
  return { name, gateway: form.gateway, pairingCode: code === "" ? null : code };
};

export const listModelKeys = (pageUrl: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.modelKeysList]());

export const setModelKey = (pageUrl: string, name: string, value: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.modelKeysSet]({ name, value }));

export const removeModelKey = (pageUrl: string, name: string) =>
  callHub(pageUrl, (client) => client[MAGNESIUM_WS_METHODS.modelKeysRemove]({ name }));

/** A spoke's state in a few words, for its row. */
export const describeSpoke = (spoke: HubSpoke): string => {
  const where = spoke.status?.node ?? spoke.spec.node;
  const build = spoke.status?.build ?? spoke.spec.build;
  const place = build === null ? `on ${where}` : `on ${where} · ${build}`;
  if (spoke.status === null) return `${spoke.detail ?? "Its gateway didn't answer."} · ${place}`;
  if (spoke.spec.replicas === 0) return `Stopped · ${place}`;
  if (!spoke.status.ready) return `${spoke.status.detail ?? "Starting."} · ${place}`;
  if (!spoke.paired) return `Up, waiting to pair with the hub · ${place}`;
  return `Running · ${place}`;
};

/** What the Add form asks for; the rest of a spec has defaults. */
export interface SpokeForm {
  readonly name: string;
  readonly node: string;
  readonly home: string;
  readonly volumeSize: string;
  /** OpenCode's gateway; blank leaves OpenCode unconfigured. */
  readonly opencodeUrl: string;
  /** Comma-separated. */
  readonly opencodeModels: string;
  /** Off creates it stopped, as when a machine's home is copied into its volume first. */
  readonly startNow: boolean;
}

/** A spec from the form, or the first thing wrong with it. */
export const specFromForm = (form: SpokeForm): SpokeSpec | { readonly problem: string } => {
  const name = form.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return { problem: "Name it with lowercase letters, digits and dashes." };
  }
  const node = form.node.trim();
  if (node === "") return { problem: "Pick the node it runs on." };
  const home = form.home.trim();
  if (!home.startsWith("/"))
    return { problem: "The home folder is a full path, such as /home/agent." };
  const volumeSize = form.volumeSize.trim();
  if (!/^[1-9][0-9]*(Mi|Gi|Ti)$/.test(volumeSize)) {
    return { problem: "Give the volume a size such as 100Gi." };
  }
  const url = form.opencodeUrl.trim();
  const models = form.opencodeModels
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (url !== "" && models.length === 0) return { problem: "Name at least one OpenCode model." };
  return {
    name,
    node,
    home,
    hostname: name.slice(0, 63),
    build: null,
    volumeSize,
    opencode: url === "" ? null : { baseUrl: url, models: [models[0]!, ...models.slice(1)] },
    replicas: form.startNow ? 1 : 0,
  };
};

/**
 * What kind of environment a machine is, for its row in Settings: one of
 * Magnesium's own pods, attached inside a workload, the gateway, or where Fleet
 * says it runs (bare metal, a VM). Null when nothing is known yet.
 */
export const describeEnvironmentKind = (input: {
  readonly fleet: FleetMachine | undefined;
  readonly spoke: HubSpoke | undefined;
  readonly attached: HubAttached | undefined;
}): string | null => {
  const { fleet, spoke, attached } = input;
  if (spoke !== undefined) {
    const node = spoke.status?.node ?? spoke.spec.node;
    return `Magnesium pod on ${node}${spoke.spec.replicas === 0 ? " · stopped" : ""}`;
  }
  if (attached !== undefined) {
    const node = fleet?.node ?? null;
    if (attached.workload === null) return node === null ? "attached" : `attached on ${node}`;
    return node === null ? `in ${attached.workload}` : `in ${attached.workload} on ${node}`;
  }
  if (fleet === undefined) return null;
  const place = describePlace(fleet);
  if (fleet.kind === "gateway") return place === null ? "gateway" : `gateway · ${place}`;
  return place;
};
