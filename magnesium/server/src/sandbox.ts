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
