// magnesium: which command signs a provider instance's CLI in on its machine
import type {
  ExecutionEnvironmentPlatformOs,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";

import { resolveOnboardingProviderLoginCommand } from "../../onboarding/providerReadiness.logic";

/** A profile's harness runs through these; profiles share the machine's own sign-in. */
const PROFILE_WRAPPERS = new Set(["magnesium-claude", "magnesium-codex"]);

const configOf = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The login command for Claude or an existing Codex install, typed into a
 * terminal on the instance's machine. A fenced stock instance names the real
 * CLI in MAGNESIUM_REAL_BIN, since its wrapper only runs under the provider.
 * Null for a profile's instance, whose login is the machine's.
 */
export function resolveProviderSignInCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string | null {
  const instance = settings.providerInstances[provider.instanceId];
  if (instance === undefined) {
    return resolveOnboardingProviderLoginCommand(provider, settings, platform);
  }
  const config = configOf(instance.config);
  const binaryPath = typeof config.binaryPath === "string" ? config.binaryPath : "";
  if (PROFILE_WRAPPERS.has(basename(binaryPath))) return null;
  const real = instance.environment?.find((entry) => entry.name === "MAGNESIUM_REAL_BIN")?.value;
  if (real === undefined)
    return resolveOnboardingProviderLoginCommand(provider, settings, platform);
  return resolveOnboardingProviderLoginCommand(
    provider,
    {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [provider.instanceId]: { ...instance, config: { ...config, binaryPath: real } },
      },
    },
    platform,
  );
}
