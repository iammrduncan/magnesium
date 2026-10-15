import * as Predicate from "effect/Predicate";
import { HttpClientError } from "effect/unstable/http";

import { isFrontDoorFailure } from "./pwa/policy.ts";

const isUnanswered = (error: unknown) =>
  HttpClientError.isHttpClientError(error) &&
  (error.reason._tag === "TransportError" ||
    (error.response !== undefined && isFrontDoorFailure(error.response.status)));

/**
 * Whether an error means the server can't be reached at all, rather than that
 * it answered with a failure (goal 05). The shell shows Offline for these.
 *
 * Covers a request that never got an answer (no network, the server down), and
 * a front door answering 502, 503 or 504 for a server behind it that is down.
 * Upstream's boot wraps both in `PrimaryEnvironmentRequestError`.
 */
export function isServerUnreachableError(error: unknown): boolean {
  if (isUnanswered(error)) return true;
  if (!Predicate.isTagged(error, "PrimaryEnvironmentRequestError")) return false;
  const status = Predicate.hasProperty(error, "status") ? error.status : undefined;
  const cause = Predicate.hasProperty(error, "cause") ? error.cause : undefined;
  return (Predicate.isNumber(status) && isFrontDoorFailure(status)) || isUnanswered(cause);
}
