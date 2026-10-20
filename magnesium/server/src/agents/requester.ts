import { parseProfileInstanceId } from "@magnesium/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ServerPorts } from "../ports.ts";

/**
 * Who asked, for a Home card (goals 34, 35): the asking agent's profile, from
 * its thread's provider instance, or its harness; an agent with no thread asked
 * from outside Magnesium.
 */
export const requesterOf = (ports: ServerPorts["Service"], threadId: string | null) =>
  Effect.gen(function* () {
    if (threadId === null) return "An agent outside Magnesium";
    const shell = yield* ports.threads
      .byId(ThreadId.make(threadId))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(shell)) return "An agent";
    const instance = shell.value.providerInstanceId;
    return parseProfileInstanceId(instance)?.profile ?? `An agent on ${instance}`;
  });
