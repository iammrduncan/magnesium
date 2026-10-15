import { MAGNESIUM_WS_METHODS, MagnesiumRpcGroup } from "@magnesium/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Footer from "./Footer.ts";

/** The footer's RPC, with the service behind it; it needs `Fleet`. Scopes are checked by the route. */
export const footerHandlersLayer = MagnesiumRpcGroup.toLayerHandler(
  MAGNESIUM_WS_METHODS.footerItems,
  Effect.gen(function* () {
    const footer = yield* Footer.Footer;
    return (input) => footer.subscribeItems(input);
  }),
).pipe(Layer.provide(Footer.layer));
