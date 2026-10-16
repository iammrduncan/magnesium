import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderSignInCommand } from "./ProviderSignInRow.logic";

const claude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const withInstance = (
  instance: ServerSettings["providerInstances"][keyof ServerSettings["providerInstances"]],
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [claude.instanceId]: instance },
});

describe("resolveProviderSignInCommand", () => {
  it("signs a fenced stock instance in with the real CLI, not the fence wrapper", () => {
    const settings = withInstance({
      driver: claude.driver,
      config: { binaryPath: "/opt/magnesium/bin/magnesium-fenced" },
      environment: [
        { name: "MAGNESIUM_SANDBOX", value: "fenced", sensitive: false },
        { name: "MAGNESIUM_REAL_BIN", value: "/home/agent/.local/bin/claude", sensitive: false },
      ],
    });
    expect(resolveProviderSignInCommand(claude, settings, "linux")).toBe(
      "/home/agent/.local/bin/claude auth login",
    );
  });

  it("uses the configured binary of an instance that isn't fenced", () => {
    const settings = withInstance({
      driver: claude.driver,
      config: { binaryPath: "/usr/local/bin/claude" },
    });
    expect(resolveProviderSignInCommand(claude, settings, "linux")).toBe(
      "/usr/local/bin/claude auth login",
    );
  });

  it("offers nothing for a profile's instance, which shares the machine's login", () => {
    const settings = withInstance({
      driver: claude.driver,
      config: { binaryPath: "/opt/magnesium/bin/magnesium-claude" },
    });
    expect(resolveProviderSignInCommand(claude, settings, "linux")).toBeNull();
  });

  it("falls back to the CLI on the PATH when there is no explicit instance", () => {
    expect(resolveProviderSignInCommand(claude, DEFAULT_SERVER_SETTINGS, "linux")).toBe(
      "claude auth login",
    );
  });
});
