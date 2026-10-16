// magnesium: sign a provider's CLI in on the machine that runs it, from Settings → Providers
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { MachineTerminal } from "../fleet/MachineTerminal";
import { Button } from "../ui/button";
import { resolveProviderSignInCommand } from "./ProviderSignInRow.logic";
import { SettingsRow } from "./settingsLayout";

/**
 * Claude and an existing Codex install sign in with their own CLI, so this
 * opens a terminal on the provider's machine with the login command typed, as
 * onboarding does on a first run. It is offered when signed in too: a CLI can
 * report a login whose token has since expired.
 */
export function ProviderSignInRow({
  environmentId,
  environmentLabel,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: ServerProvider;
}) {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const serverConfig = presentation?.serverConfig ?? null;
  const [open, setOpen] = useState(false);
  const command =
    serverConfig === null
      ? null
      : resolveProviderSignInCommand(
          provider,
          serverConfig.settings,
          serverConfig.environment.platform.os,
        );
  const signedOut = provider.auth.status === "unauthenticated";
  // A profile's instance signs in with the machine; its own row would only repeat that.
  if (serverConfig !== null && command === null) return null;

  return (
    <section aria-label="Sign in" className="divide-y divide-border/50 text-xs">
      <SettingsRow
        title="Sign in"
        description={
          signedOut
            ? `Not signed in on ${environmentLabel}. Opens a terminal there with the login command typed in.`
            : `Opens a terminal on ${environmentLabel} with the login command typed in, to sign in again.`
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={command === null || open}
            onClick={() => setOpen(true)}
          >
            <TerminalIcon />
            Sign in
          </Button>
        }
      />
      {open && command !== null ? (
        <div className="py-3">
          <MachineTerminal
            environmentId={environmentId}
            label={environmentLabel}
            command={command}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </section>
  );
}
