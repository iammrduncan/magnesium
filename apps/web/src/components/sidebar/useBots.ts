// magnesium: the hub's profiles as bots (goal 34, D68), for the sidebar and the command palette
import { type Bot, botConversation, botsOf } from "@magnesium/web";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { type EnvironmentId, type ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useProfileList } from "../profiles/profilesData";

/**
 * Starts a thread without a project in an environment, on a profile's
 * instance there, with that instance's first model chosen: a bot's new
 * conversation, or a profile's New thread.
 */
export function useStartProfileThread() {
  const serverConfigs = useServerConfigs();
  const { openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (environmentId: EnvironmentId, instanceId: string, failureTitle: string) => {
      const project = await openScratchProject(environmentId, failureTitle);
      if (project === null) return;
      const draft = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
      if (draft === null) return;
      const instance = instanceId as ProviderInstanceId;
      const model = serverConfigs
        .get(environmentId)
        ?.providers.find((provider) => provider.instanceId === instance)?.models[0]?.slug;
      if (model !== undefined) {
        useComposerDraftStore
          .getState()
          .setModelSelection(draft.draftId, createModelSelection(instance, model), {
            explicit: true,
          });
      }
    },
    [handleNewThread, openScratchProject, serverConfigs],
  );
}

/**
 * Each profile the hub runs, as a bot: `open` goes to your conversation with
 * it on the hub, starting one when there is none, and `startOver` archives
 * that conversation and starts another.
 */
export function useBots() {
  const hubId = usePrimaryEnvironmentId();
  const { list, refresh } = useProfileList();
  const bots = useMemo(() => (list === null ? [] : botsOf(list)), [list]);
  const threads = useThreadShells(bots.length > 0);
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const startProfileThread = useStartProfileThread();
  const { archiveThread } = useThreadActions();
  const navigate = useNavigate();

  // Sync adds a bot's instance on the hub a moment after its profile is saved: read the list again then.
  const hubInstances =
    hubId === null
      ? ""
      : (serverConfigs
          .get(hubId)
          ?.providers.map((provider) => provider.instanceId)
          .join(" ") ?? "");
  useEffect(() => {
    if (hubInstances !== "") void refresh();
  }, [hubInstances, refresh]);

  const scratchRoot = scratchWorkspaceRootFor(hubId);
  const scratchProjectIds = useMemo(
    () =>
      new Set<string>(
        projects
          .filter(
            (project) => project.environmentId === hubId && isScratchProject(project, scratchRoot),
          )
          .map((project) => project.id),
      ),
    [hubId, projects, scratchRoot],
  );
  const conversationOf = useCallback(
    (bot: Bot) =>
      hubId === null
        ? null
        : botConversation(threads, { environmentId: hubId, scratchProjectIds, profile: bot.name }),
    [hubId, scratchProjectIds, threads],
  );

  /** A new conversation: a thread without a project on the hub, on the bot's instance. */
  const startConversation = (bot: Bot) =>
    hubId === null
      ? Promise.resolve()
      : startProfileThread(hubId, bot.instanceId, `Could not start talking to ${bot.displayName}`);

  const open = async (bot: Bot) => {
    const conversation = conversationOf(bot);
    if (conversation === null || hubId === null) return startConversation(bot);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(hubId, ThreadId.make(conversation.id))),
    });
  };

  const startOver = async (bot: Bot) => {
    const conversation = conversationOf(bot);
    if (conversation !== null && hubId !== null) {
      const archived = await archiveThread(scopeThreadRef(hubId, ThreadId.make(conversation.id)));
      if (archived._tag === "Failure") return;
    }
    await startConversation(bot);
  };

  return { hubId, bots, conversationOf, open, startOver };
}
