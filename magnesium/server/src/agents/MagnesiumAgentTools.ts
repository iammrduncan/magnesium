import type {
  ProfileCheckResult,
  ProfileDetail,
  ProfileError,
  ProfileList,
  ProfileRequest,
  ProfileRequestInput,
  ProfileSendResult,
} from "@magnesium/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { checkProfiles, listProfiles } from "../profiles/catalog.ts";
import { ProfileRequests } from "../profiles/ProfileRequests.ts";
import { ProfileStore } from "../profiles/ProfileStore.ts";
import { HubProfilePusher } from "../profiles/HubProfilePusher.ts";
import type { AgentServices } from "./operations.ts";

/**
 * What an agent can do with profiles (goal 34, D65), through the MCP server
 * every thread already has and through the agents API: read them freely, and
 * ask to change one. Asking never changes anything: the request waits on Home
 * for the owner, and the hub applies it only when approved.
 */
export class MagnesiumAgentTools extends Context.Service<
  MagnesiumAgentTools,
  {
    readonly listProfiles: Effect.Effect<ProfileList>;
    readonly getProfile: (name: string) => Effect.Effect<ProfileDetail, ProfileError>;
    readonly checkProfiles: (names: ReadonlyArray<string>) => Effect.Effect<ProfileCheckResult>;
    /** `threadId` is the asking agent's thread, so Home can show which one asked. */
    readonly requestProfileChange: (
      input: ProfileRequestInput,
      threadId: string | null,
    ) => Effect.Effect<ProfileRequest, ProfileError>;
    readonly profileRequest: (id: string) => Effect.Effect<ProfileRequest, ProfileError>;
    readonly sendNow: Effect.Effect<ProfileSendResult>;
  }
>()("@magnesium/server/agents/MagnesiumAgentTools") {}

export const layer = Layer.effect(
  MagnesiumAgentTools,
  Effect.gen(function* () {
    const store = yield* ProfileStore;
    const requests = yield* ProfileRequests;
    const context = yield* Effect.context<AgentServices>();
    const withContext = <A, E>(effect: Effect.Effect<A, E, AgentServices>) =>
      effect.pipe(Effect.provideContext(context));
    // Taken now: callers run in upstream's MCP server, whose context has no pusher.
    const pusher = yield* Effect.serviceOption(HubProfilePusher);
    const pushes = Option.isSome(pusher) ? pusher.value.status : Effect.succeed([]);
    return MagnesiumAgentTools.of({
      listProfiles: withContext(pushes.pipe(Effect.flatMap(listProfiles))).pipe(Effect.orDie),
      getProfile: store.detail,
      checkProfiles: (names) => withContext(checkProfiles(names)).pipe(Effect.orDie),
      requestProfileChange: requests.ask,
      profileRequest: requests.get,
      sendNow: store.sendNow.pipe(
        Effect.andThen(pushes),
        Effect.map((statuses) => ({ pushes: statuses })),
      ),
    });
  }),
);
