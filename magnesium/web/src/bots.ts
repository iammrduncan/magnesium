import {
  parseProfileInstanceId,
  type ProfileList,
  type ProfileSummary,
} from "@magnesium/contracts";

/**
 * Bots (D68): each profile that runs on the hub is a bot in the sidebar, and
 * clicking it opens your one long-running conversation with it. That
 * conversation is the newest open thread without a project on the hub that
 * runs the profile, so it needs no record of its own: New conversation
 * archives it, and the next click starts another.
 */

export interface Bot {
  readonly name: string;
  readonly displayName: string;
  readonly avatar: string;
  readonly accentColor: string;
  /** The hub's instance a new conversation starts on: its main harness, at its default level. */
  readonly instanceId: string;
}

/** The instance a profile starts on where it runs: its main harness at its default level, if there. */
export const mainInstanceOf = (profile: ProfileSummary) =>
  profile.instances.find(
    (candidate) => candidate.harness === profile.harness && candidate.sandbox === profile.sandbox,
  ) ??
  profile.instances.find((candidate) => candidate.sandbox === profile.sandbox) ??
  profile.instances[0];

/** The hub's bots, from its profile list: those that run there, in the list's order. */
export function botsOf(list: ProfileList): ReadonlyArray<Bot> {
  return list.profiles.flatMap((profile) => {
    if (!profile.runsHere) return [];
    const instance = mainInstanceOf(profile);
    if (instance === undefined) return [];
    return [
      {
        name: profile.name,
        displayName: profile.displayName,
        avatar: profile.avatar,
        accentColor: profile.accentColor,
        instanceId: instance.instanceId,
      },
    ];
  });
}

interface ThreadLike {
  readonly environmentId: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

/** A bot's conversation: its newest open thread in the hub's scratch project, or null. */
export function botConversation<Thread extends ThreadLike>(
  threads: Iterable<Thread>,
  where: {
    readonly environmentId: string;
    readonly scratchProjectIds: ReadonlySet<string>;
    readonly profile: string;
  },
): Thread | null {
  let newest: Thread | null = null;
  for (const thread of threads) {
    if (
      thread.environmentId !== where.environmentId ||
      thread.archivedAt !== null ||
      !where.scratchProjectIds.has(thread.projectId) ||
      parseProfileInstanceId(thread.providerInstanceId)?.profile !== where.profile
    ) {
      continue;
    }
    if (newest === null || thread.updatedAt > newest.updatedAt) newest = thread;
  }
  return newest;
}
