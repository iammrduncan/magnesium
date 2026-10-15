import * as Schema from "effect/Schema";

/**
 * The footer (goal 05, doc 14): a thin status bar on every page, a row of
 * short items, each opening a popover. The hub fills each item's label and
 * streams the rows on `magnesium.footer.items`; the browser decides what each
 * item's popover shows, from a registry keyed by the same id.
 */

/** `<namespace>:<name>`: `core:` for Magnesium's own items, an app's id for its items (goal 16). */
export const FOOTER_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$/;
export const FooterItemId = Schema.String.check(Schema.isPattern(FOOTER_ITEM_ID_PATTERN));
export type FooterItemId = typeof FooterItemId.Type;

/** How loudly an item speaks: `neutral` is quiet; `warning` and `danger` ask to be looked at. */
export const FooterTone = Schema.Literals(["neutral", "info", "success", "warning", "danger"]);
export type FooterTone = typeof FooterTone.Type;

export const FooterItem = Schema.Struct({
  id: FooterItemId,
  /** Core items sit on the left, app items on the right. */
  side: Schema.Literals(["left", "right"]),
  /** Lower comes first within its side. */
  order: Schema.Int,
  /** What the bar shows, such as "5 machines · 1 offline". */
  label: Schema.String,
  /** The tooltip: what the label leaves out. */
  detail: Schema.NullOr(Schema.String),
  tone: FooterTone,
  /** The item's name in the footer settings, where it is hidden or shown. */
  toggleLabel: Schema.String,
});
export type FooterItem = typeof FooterItem.Type;

export const footerItemKey = (item: Pick<FooterItem, "id">) => item.id;
