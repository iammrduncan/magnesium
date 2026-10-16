import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerPorts } from "../ports.ts";

/**
 * A pairing code from the environment (goal 25), so the hub can give itself
 * access to a server nobody runs a command on: whatever deploys the server puts
 * a random code in `MAGNESIUM_HUB_PAIRING_CODE` (from a Secret), and the hub
 * pairs with it as with a code from `magnesium-release pair`. It is registered
 * once and lasts a week; pairing spends it, and a restart never re-arms it.
 */

export const PAIRING_CODE_ENV = "MAGNESIUM_HUB_PAIRING_CODE";
/** Shorter codes are guessable; this one isn't typed by hand. */
export const PAIRING_CODE_MIN_LENGTH = 16;
const LIFETIME_DAYS = 7;

/** The code in `env`, or why it isn't usable; null when there is none. */
export const pairingCodeFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly code: string } | { readonly refused: string } | null => {
  const code = env[PAIRING_CODE_ENV]?.trim();
  if (!code) return null;
  if (code.length < PAIRING_CODE_MIN_LENGTH) {
    return {
      refused: `${PAIRING_CODE_ENV} is shorter than ${PAIRING_CODE_MIN_LENGTH} characters, so it was not registered.`,
    };
  }
  return { code };
};

export const pairingCodeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const found = pairingCodeFromEnv(process.env);
    if (found === null) return;
    if ("refused" in found) return yield* Effect.logWarning(found.refused);
    const ports = yield* ServerPorts;
    if (ports.registerPairingCode === undefined) return;
    const expiresAt = DateTime.add(yield* DateTime.now, { days: LIFETIME_DAYS });
    // Never log the code itself.
    const registered = yield* ports
      .registerPairingCode({ code: found.code, label: "Magnesium hub", expiresAt })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not register ${PAIRING_CODE_ENV}.`, error.detail).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (registered) {
      yield* Effect.logInfo(
        `Registered ${PAIRING_CODE_ENV} for the hub, for ${LIFETIME_DAYS} days.`,
      );
    }
  }),
);
