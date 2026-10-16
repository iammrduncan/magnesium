import { MAGNESIUM_WS_PATH } from "@magnesium/contracts";
import * as Effect from "effect/Effect";

import { urlUnder } from "../forward.ts";
import { connect } from "../rpc/client.ts";
import { HubMachines } from "./HubMachines.ts";
import * as MachineApi from "./machineApi.ts";

/**
 * Opens a machine's `MagnesiumRpcGroup` as the hub, for the life of the
 * scope (D35: the hub dials out; machines never dial in). The hub mints a
 * WebSocket ticket on the machine with its own token, the way its proxy does
 * for `/ws`, so the token never rides in a URL.
 */
export const connectMachine = Effect.fn("HubMachines.connectMachine")(function* (name: string) {
  const machines = yield* HubMachines;
  const upstream = yield* machines.upstream(name);
  const ticket = yield* MachineApi.issueWebSocketTicket(upstream.url, upstream.token).pipe(
    Effect.tapError((error) => (error.rejected ? machines.markRejected(name) : Effect.void)),
  );
  const url = urlUnder(upstream.url, MAGNESIUM_WS_PATH);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket.ticket);
  return yield* connect(url.toString());
});
