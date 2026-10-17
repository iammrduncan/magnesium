import {
  type HubSpoke,
  type HubSpokeApplyInput,
  MAGNESIUM_WS_METHODS,
  type SpokeRemoveInput,
  type SpokeSpec,
} from "@magnesium/contracts";
import * as Effect from "effect/Effect";

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
