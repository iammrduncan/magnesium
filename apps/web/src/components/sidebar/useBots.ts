// magnesium: the hub's profiles as bots (goal 34, D68), for the sidebar and the command palette
import { type Bot, botConversation, botsOf } from "@magnesium/web";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { type ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useProfileList } from "../profiles/profilesData";

/**
 * Each profile the hub runs, as a bot: `open` goes to your conversation with
 * it on the hub, starting one when there is none, and `startOver` archives
 * that conversation and starts another.
 */
export function useBots() {
  const hubId = usePrimaryEnvironmentId();
  const { list } = useProfileList();
  const bots = useMemo(() => (list === null ? [] : botsOf(list)), [list]);
  const threads = useThreadShells(bots.length > 0);
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread } = useThreadActions();
  const navigate = useNavigate();

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
  const startConversation = async (bot: Bot) => {
    if (hubId === null) return;
    const project = await openScratchProject(
      hubId,
      `Could not start talking to ${bot.displayName}`,
    );
    if (project === null) return;
    const draft = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (draft === null) return;
    const instanceId = bot.instanceId as ProviderInstanceId;
    const model = serverConfigs
      .get(hubId)
      ?.providers.find((provider) => provider.instanceId === instanceId)?.models[0]?.slug;
    if (model !== undefined) {
      useComposerDraftStore
        .getState()
        .setModelSelection(draft.draftId, createModelSelection(instanceId, model), {
          explicit: true,
        });
    }
  };

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
