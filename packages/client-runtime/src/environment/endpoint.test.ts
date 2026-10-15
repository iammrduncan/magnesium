import { describe, expect, it } from "vite-plus/test";

import {
  classifyHostedHttpsCompatibility,
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/api")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("marks HTTP endpoints as blocked from hosted HTTPS apps", () => {
    expect(classifyHostedHttpsCompatibility("http://192.168.1.44:3773")).toBe(
      "mixed-content-blocked",
    );
    expect(classifyHostedHttpsCompatibility("https://desktop.example.com", "compatible")).toBe(
      "compatible",
    );
  });

  it("creates provider-neutral endpoint records", () => {
    expect(
      createAdvertisedEndpoint({
        id: "lan:http://192.168.1.44:3773",
        label: "LAN",
        provider: coreProvider,
        httpBaseUrl: "http://192.168.1.44:3773",
        reachability: "lan",
        source: "desktop-core",
        isDefault: true,
      }),
    ).toEqual({
      id: "lan:http://192.168.1.44:3773",
      label: "LAN",
      provider: coreProvider,
      httpBaseUrl: "http://192.168.1.44:3773/",
      wsBaseUrl: "ws://192.168.1.44:3773/",
      reachability: "lan",
      compatibility: {
        hostedHttpsApp: "mixed-content-blocked",
        desktopApp: "compatible",
      },
      source: "desktop-core",
      status: "available",
      isDefault: true,
    });
  });
});

// magnesium: machines the hub carries live under a path on the hub's origin
describe("environmentEndpointUrl", () => {
  it("joins endpoint paths under the base URL's path", () => {
    expect(environmentEndpointUrl("http://127.0.0.1:3773", "/api/auth/session")).toBe(
      "http://127.0.0.1:3773/api/auth/session",
    );
    expect(
      environmentEndpointUrl("https://hub.example.test/api/magnesium/env/cpu-host-1/", "/ws"),
    ).toBe("https://hub.example.test/api/magnesium/env/cpu-host-1/ws");
    expect(
      environmentEndpointUrl("https://hub.example.test/api/magnesium/env/cpu-host-1?x=1", "/api"),
    ).toBe("https://hub.example.test/api/magnesium/env/cpu-host-1/api");
  });
});
