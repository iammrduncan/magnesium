// magnesium: one Home watch shared by the sidebar's place, the Home page and the footer (goal 06)
import {
  createAnswerHold,
  type HeldAnswer,
  type HomeView,
  type HomeWatch,
  initialHomeView,
  magnesiumSocketUrl,
  watchHome,
} from "@magnesium/web";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useSyncExternalStore } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";

let view: HomeView = initialHomeView;
let watch: HomeWatch | null = null;
const listeners = new Set<() => void>();

/** Opens the hub's Home streams on the first subscriber and closes them after the last. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (watch === null) {
    watch = watchHome(magnesiumSocketUrl(window.location.href), (next) => {
      view = next;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watch !== null) {
      watch.dispose();
      watch = null;
      view = initialHomeView;
    }
  };
}

export function useHomeView(): HomeView {
  return useSyncExternalStore(subscribe, () => view);
}

/** The live watch while anything is subscribed, for pins and Detail. */
export function currentHomeWatch(): HomeWatch | null {
  return watch;
}

/** Answers held for Undo, one per card; they go to the hub when the hold runs out. */
export const answerHold = createAnswerHold({
  send: async (key, answer) => {
    const item = view.items.rows.get(key);
    if (watch === null) throw new Error("Not connected to the hub.");
    await watch.answer(key, answer);
    // An implemented plan leaves plan mode, as the thread's own Implement does, so
    // the next message from its composer doesn't put the thread back into planning.
    if (answer._tag === "plan" && item?.machine.environmentId != null && item.threadId !== null) {
      useComposerDraftStore
        .getState()
        .setInteractionMode(scopeThreadRef(item.machine.environmentId, item.threadId), "default");
    }
  },
});

export function useHeldAnswers(): ReadonlyMap<string, HeldAnswer> {
  return useSyncExternalStore(answerHold.subscribe, answerHold.current);
}
