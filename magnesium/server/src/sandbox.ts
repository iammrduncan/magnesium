/**
 * Magnesium's fence or container is the agent's sandbox (goal 03). A harness's own
 * sandbox (Codex's needs bubblewrap) can't start inside either, so each command
 * would be approved twice: once to run, once to run unsandboxed. Under them the
 * harness's sandbox is off; its approval policy is left as the runtime mode sets
 * it, so a supervised thread still asks before every command. `native` keeps the
 * harness's own sandbox.
 */
export const isMagnesiumSandboxed = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
): boolean =>
  environment?.MAGNESIUM_SANDBOX === "fenced" || environment?.MAGNESIUM_SANDBOX === "container";

/**
 * Where a provider's instance-level health checks run. Upstream runs them in the
 * server's state folder, out of `$HOME`; Magnesium's fence keeps a fenced agent
 * out of that folder (D46), so a fenced instance checks itself in the temp folder.
 */
export const providerProbeDir = (
  environment: Readonly<Record<string, string | undefined>>,
  stateDir: string,
): string => (isMagnesiumSandboxed(environment) ? (environment.TMPDIR ?? "/tmp") : stateDir);
