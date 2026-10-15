import { isManagedInstanceId, nativeTwinInstanceId } from "@magnesium/contracts";
import {
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import type { MachineSetup, PlannedInstance } from "./homes.ts";

/**
 * Every agent Magnesium launches is fenced by default (D40), the stock provider
 * instances included: profile sync points each stock Claude, Codex and OpenCode
 * instance's binary at `magnesium-fenced`, keeping its id, home and settings, so
 * existing threads carry on, now fenced. Each gets an unfenced twin
 * (`mg_native_<id>`) sharing its home, for the per-thread `native` choice.
 */

/** Drivers that run a local CLI the fence can wrap. Cursor runs in the server; others stay as they are. */
const FENCED_DRIVERS: Record<string, { readonly binary: string; readonly label: string }> = {
  claudeAgent: { binary: "claude", label: "Claude" },
  codex: { binary: "codex", label: "Codex" },
  opencode: { binary: "opencode", label: "OpenCode" },
};
const MAGNESIUM_ENV = /^MAGNESIUM_/;

const configOf = (instance: ProviderInstanceConfig): Record<string, unknown> =>
  Predicate.isObject(instance.config) ? (instance.config as Record<string, unknown>) : {};

const envValue = (instance: ProviderInstanceConfig, name: string) =>
  instance.environment?.find((entry) => entry.name === name)?.value;

const withoutOurs = (instance: ProviderInstanceConfig): ProviderInstanceEnvironmentVariable[] =>
  (instance.environment ?? []).filter((entry) => !MAGNESIUM_ENV.test(entry.name));

const ourEnv = (values: Record<string, string>): ProviderInstanceEnvironmentVariable[] =>
  Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value, sensitive: false }));

/**
 * The provider instances settings should hold: every instance profile sync does
 * not own, as it is but fenced, plus the profiles' instances. Pure, so it can be
 * compared with what is there and written only on a change.
 */
export const desiredInstances = (input: {
  readonly path: Path.Path;
  readonly settings: ServerSettings;
  readonly setup: MachineSetup;
  readonly profiles: ReadonlyArray<PlannedInstance>;
  /** Whether a CLI named by a bare command or a path is on this machine. */
  readonly installed: (binary: string) => boolean;
}): Record<string, ProviderInstanceConfig> => {
  const { path, settings, setup } = input;
  const next: Record<string, ProviderInstanceConfig> = {};
  for (const [id, instance] of Object.entries(settings.providerInstances)) {
    if (!isManagedInstanceId(id)) next[id] = instance;
  }
  // A stock driver with no explicit instance runs as its legacy default; make it explicit to fence it.
  for (const [driver, info] of Object.entries(FENCED_DRIVERS)) {
    if (next[driver] !== undefined) continue;
    const legacy = (settings.providers as Record<string, unknown>)[driver];
    if (!Predicate.isObject(legacy)) continue;
    const { enabled, ...config } = legacy as Record<string, unknown>;
    if (enabled !== true) continue;
    if (
      !input.installed(
        typeof config.binaryPath === "string" && config.binaryPath
          ? config.binaryPath
          : info.binary,
      )
    ) {
      continue;
    }
    next[driver] = { driver: ProviderDriverKind.make(driver), enabled: true, config };
  }

  const fencedWrapper =
    setup.wrapperDir === undefined ? undefined : path.join(setup.wrapperDir, "magnesium-fenced");
  if (fencedWrapper !== undefined) {
    for (const [id, instance] of Object.entries(next)) {
      const info = FENCED_DRIVERS[instance.driver];
      if (info === undefined) continue;
      const config = configOf(instance);
      // An OpenCode instance pointed at an outside server runs nothing here to fence.
      if (typeof config.serverUrl === "string" && config.serverUrl.trim()) continue;
      // A stock instance someone set to native by hand stays native.
      if (envValue(instance, "MAGNESIUM_SANDBOX") === "native") continue;
      const configured =
        typeof config.binaryPath === "string" && config.binaryPath.trim()
          ? config.binaryPath
          : info.binary;
      const real =
        configured === fencedWrapper
          ? (envValue(instance, "MAGNESIUM_REAL_BIN") ?? info.binary)
          : configured;
      if (!input.installed(real)) continue;
      next[id] = {
        ...instance,
        environment: [
          ...withoutOurs(instance),
          ...ourEnv({
            MAGNESIUM_SANDBOX: "fenced",
            MAGNESIUM_REAL_BIN: real,
            MAGNESIUM_STATE_HOME: setup.stateHome,
            MAGNESIUM_FENCE: "mechanism" in setup.fence ? setup.fence.mechanism : "",
            MAGNESIUM_FENCE_PROTECT: setup.protect.join(":"),
          }),
        ],
        config: { ...config, binaryPath: fencedWrapper },
      };
      next[ProviderInstanceId.make(nativeTwinInstanceId(id))] = {
        driver: instance.driver,
        displayName: `${instance.displayName ?? info.label} · native`,
        ...(instance.accentColor !== undefined ? { accentColor: instance.accentColor } : {}),
        environment: [...withoutOurs(instance), ...ourEnv({ MAGNESIUM_SANDBOX: "native" })],
        ...(instance.enabled !== undefined ? { enabled: instance.enabled } : {}),
        config: { ...config, binaryPath: real },
      };
    }
  }

  for (const planned of input.profiles) next[planned.instanceId] = planned.config;
  return next;
};
