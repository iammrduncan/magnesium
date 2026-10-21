// magnesium: the machines the hub carries but cannot reach yet, and the way to give it access (doc 11)
import type { HubMachine } from "@magnesium/contracts";
import {
  fetchHubMachines,
  giveHubAccess,
  hubMachineNameOf,
  removeHubAccess,
  runHubRequest,
} from "@magnesium/web";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { EnvironmentRow } from "./EnvironmentRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const REFRESH_MS = 15_000;

const hubBaseUrl = () => new URL("/", window.location.origin).toString();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The hub did not answer.";

/** Removes the hub's access to the machine behind a hub environment; null on success. */
export async function removeHubMachineAccess(target: {
  readonly httpBaseUrl: string;
}): Promise<string | null> {
  const name = hubMachineNameOf(target);
  if (name === null) return "This environment is not one the hub carries.";
  try {
    await runHubRequest(removeHubAccess(new URL("/", target.httpBaseUrl).toString(), name));
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function machineStatus(machine: HubMachine): string {
  const access =
    machine.access === "expired" ? "The hub's access ran out" : "The hub has no access yet";
  return machine.online ? access : `${access} · Offline`;
}

function GiveAccessDialog({
  machine,
  onGiven,
}: {
  readonly machine: HubMachine;
  readonly onGiven: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await runHubRequest(giveHubAccess(hubBaseUrl(), machine.name, { pairingCode: code.trim() }));
      setOpen(false);
      setCode("");
      onGiven();
    } catch (cause) {
      setError(errorMessage(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Give access</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Give the hub access to {machine.label}</DialogTitle>
          <DialogDescription>
            Run <code>magnesium-release pair</code> on {machine.label} and enter its pairing code.
            The hub keeps the access for every device signed in to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Pairing code</span>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="PAIRCODE"
              disabled={busy}
              spellCheck={false}
            />
          </label>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy || code.trim() === ""} onClick={() => void submit()}>
            {busy ? "Giving access…" : "Give access"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Machines the hub lists but cannot reach, so they are not environments yet.
 * The ones it can reach are in the Environments list above. Renders nothing
 * on a server that is not a hub, or when every machine is reachable.
 */
export function HubMachinesSection({ canManage }: { readonly canManage: boolean }) {
  const [machines, setMachines] = useState<ReadonlyArray<HubMachine>>([]);

  const refresh = useCallback(async () => {
    try {
      setMachines(await runHubRequest(fetchHubMachines(hubBaseUrl())));
    } catch {
      // Not a hub, or the hub is unreachable: keep what we last showed.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const waiting = machines.filter((machine) => machine.access !== "ready");
  if (waiting.length === 0) return null;

  return (
    <SettingsSection title="Hub machines">
      {waiting.map((machine) => (
        <EnvironmentRow
          key={machine.name}
          kind="server"
          label={machine.label}
          subtitle={<span className="block truncate">{machineStatus(machine)}</span>}
          dimmed
        >
          {canManage ? <GiveAccessDialog machine={machine} onGiven={() => void refresh()} /> : null}
        </EnvironmentRow>
      ))}
      {canManage ? null : (
        <SettingsRow
          title="Admin access needed"
          description="Sign in to the hub with an admin link to give it access to these machines."
        />
      )}
    </SettingsSection>
  );
}
