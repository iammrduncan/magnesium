// magnesium: one footer.items watch shared by every footer consumer (goal 05)
import {
  type FooterView,
  initialFooterView,
  magnesiumSocketUrl,
  watchFooter,
} from "@magnesium/web";
import { useSyncExternalStore } from "react";

let view: FooterView = initialFooterView;
let watch: { readonly dispose: () => void } | null = null;
const listeners = new Set<() => void>();

/** Opens the hub's footer stream on the first subscriber and closes it after the last. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (watch === null) {
    watch = watchFooter(magnesiumSocketUrl(window.location.href), (next) => {
      view = next;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watch !== null) {
      watch.dispose();
      watch = null;
      view = initialFooterView;
    }
  };
}

/**
 * A narrow slice of the footer's view. `select` must return something that
 * stays the same while it is unchanged, such as the rows map or a string, so
 * a change elsewhere does not re-render the caller.
 */
export function useFooterView<Selected>(select: (view: FooterView) => Selected): Selected {
  return useSyncExternalStore(subscribe, () => select(view));
}
