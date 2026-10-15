// magnesium: the footer's registry and its per-device settings (goal 05, doc 14)
import type { FooterItem } from "@magnesium/contracts";
import { createFooterRegistry, type FooterRegistration } from "@magnesium/web";
import * as Schema from "effect/Schema";
import { type ComponentType, useSyncExternalStore } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CORE_FOOTER_ITEMS } from "./coreFooterItems";

export interface FooterPopoverProps {
  readonly item: FooterItem;
  /** Closes the popover, for a link that navigates away. */
  readonly close: () => void;
}

/** The browser half of a footer item. Magnesium's own items register here as an app's will (goal 16). */
export interface FooterItemRegistration extends FooterRegistration {
  /** What the item shows when opened; it mounts only while open. */
  readonly Popover: ComponentType<FooterPopoverProps>;
  /** The small mark before the label, drawn in the item's tone; a dot when absent. */
  readonly Mark?: ComponentType;
}

// The app host (goal 16) registers each enabled app's items here too, and disposes them when it turns off.
const footerRegistry = createFooterRegistry<FooterItemRegistration>();
for (const registration of CORE_FOOTER_ITEMS) footerRegistry.register(registration);

export function useFooterRegistrations(): ReadonlyMap<string, FooterItemRegistration> {
  return useSyncExternalStore(footerRegistry.subscribe, footerRegistry.current);
}

const FOOTER_HIDDEN_STORAGE_KEY = "magnesium:footer-hidden:v1";
const FooterHidden = Schema.Array(Schema.String);
const NOTHING_HIDDEN: ReadonlyArray<string> = [];

/** The ids this device hides from the footer, remembered per device like upstream's panel toggles. */
export function useFooterHidden() {
  return useLocalStorage(FOOTER_HIDDEN_STORAGE_KEY, NOTHING_HIDDEN, FooterHidden);
}
