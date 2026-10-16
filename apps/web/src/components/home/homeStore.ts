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
import { useSyncExternalStore } from "react";

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
  send: (key, answer) =>
    watch?.answer(key, answer) ?? Promise.reject(new Error("Not connected to the hub.")),
});

export function useHeldAnswers(): ReadonlyMap<string, HeldAnswer> {
  return useSyncExternalStore(answerHold.subscribe, answerHold.current);
}
