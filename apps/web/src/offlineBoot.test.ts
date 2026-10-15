// magnesium: the boot's failure when the hub can't be reached is the one the
// root route shows as Offline (goal 05).
import { isServerUnreachableError } from "@magnesium/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/** What the network does for this test; the app's own HTTP client calls it. */
let network: () => Promise<Response> = () => Promise.reject(new TypeError("Failed to fetch"));

async function bootError(answer: () => Promise<Response>): Promise<unknown> {
  network = answer;
  const { resolveInitialServerAuthGateState } = await import("./environments/primary");
  const boot = resolveInitialServerAuthGateState().then(
    () => undefined,
    (error: unknown) => error,
  );
  // Upstream retries 502 to 504 for 15 seconds, for a server that is restarting.
  await vi.advanceTimersByTimeAsync(16_000);
  return boot;
}

const answer = (status: number, body: string) => () =>
  Promise.resolve(new Response(body, { status, headers: { "content-type": "text/plain" } }));

describe("booting without the hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: new URL("https://hub.example.test/"),
      history: { replaceState: () => undefined },
    });
    vi.stubGlobal("document", { title: "Magnesium" });
    // The live HTTP layer takes the global fetch when it is first built.
    vi.stubGlobal("fetch", () => network());
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is Offline when the network is down or the hub is stopped", async () => {
    const error = await bootError(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(error).toBeDefined();
    expect(isServerUnreachableError(error)).toBe(true);
  });

  it("is Offline when the front door answers 502 for a stopped hub", async () => {
    const error = await bootError(answer(502, "Bad Gateway"));
    expect(error).toBeDefined();
    expect(isServerUnreachableError(error)).toBe(true);
  });

  it("is an error, not Offline, when the hub answers with a failure", async () => {
    const error = await bootError(answer(500, "Internal Server Error"));
    expect(error).toBeDefined();
    expect(isServerUnreachableError(error)).toBe(false);
  });
});
