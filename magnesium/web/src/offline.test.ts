import { describe, expect, it } from "@effect/vitest";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { isServerUnreachableError } from "./offline.ts";

const request = HttpClientRequest.get("https://hub.example.test/api/auth/session");
const transportFailure = new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({ request, cause: new TypeError("Failed to fetch") }),
});
const statusFailure = (status: number) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response("", { status })),
    }),
  });
/** The shape of upstream's `PrimaryEnvironmentRequestError`. */
const bootFailure = (status: number, cause: unknown) => ({
  _tag: "PrimaryEnvironmentRequestError",
  operation: "fetch-session-state",
  status,
  cause,
});

describe("isServerUnreachableError", () => {
  it("is true when a request got no answer", () => {
    expect(isServerUnreachableError(transportFailure)).toBe(true);
    expect(isServerUnreachableError(bootFailure(500, transportFailure))).toBe(true);
  });

  it("is true when the front door says the server behind it is down", () => {
    for (const status of [502, 503, 504]) {
      expect(isServerUnreachableError(bootFailure(status, statusFailure(status)))).toBe(true);
      expect(isServerUnreachableError(statusFailure(status))).toBe(true);
    }
  });

  it("is false when the server answered, even with an error", () => {
    expect(isServerUnreachableError(bootFailure(500, statusFailure(500)))).toBe(false);
    expect(isServerUnreachableError(bootFailure(401, statusFailure(401)))).toBe(false);
    expect(isServerUnreachableError(statusFailure(500))).toBe(false);
  });

  it("is false for errors that aren't about reaching the server", () => {
    expect(isServerUnreachableError(new TypeError("x is undefined"))).toBe(false);
    expect(isServerUnreachableError(new Error("Something went wrong"))).toBe(false);
    expect(isServerUnreachableError(undefined)).toBe(false);
  });
});
