// magnesium: the parts footer items share, as on the Footer boards (goal 05)
import type { ReactNode } from "react";

import { PopoverTitle } from "../ui/popover";

/** The default mark before an item's label: a dot in the item's tone. */
export function FooterDotMark() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />;
}

/** A popover's title, ruled off from what follows. */
export function FooterPopoverHeader({ title }: { readonly title: string }) {
  return (
    <div className="-mx-(--viewport-inline-padding) mb-1 border-b border-border px-(--viewport-inline-padding) pb-2">
      <PopoverTitle>{title}</PopoverTitle>
    </div>
  );
}

/** A line of muted text: an empty, offline or error state. */
export function FooterPopoverNote({ children }: { readonly children: ReactNode }) {
  return <p className="py-1 text-xs text-muted-foreground">{children}</p>;
}
