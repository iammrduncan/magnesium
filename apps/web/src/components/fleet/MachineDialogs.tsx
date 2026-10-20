// magnesium: Fleet's machine dialogs (goal 35): add a machine by its address, give the hub access again, forget one
import type { FleetMachine } from "@magnesium/contracts";
import { addHubMachine, forgetHubMachine, giveHubAccess, runHubRequest } from "@magnesium/web";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const hubBaseUrl = () => new URL("/", window.location.origin).toString();
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The hub did not take that.";

/** Where a machine's pairing code comes from, for every dialog that asks for one. */
const CODE_HINT = "From the machine: Settings → Connections, or magnesium-release pair there.";

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
      />
    </label>
  );
}

/** A machine already running Magnesium, added by its address and a pairing code from it. */
export function AddMachineDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdded: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== "" && url.trim() !== "" && code.trim() !== "";
  const submit = () => {
    setBusy(true);
    setError(null);
    runHubRequest(
      addHubMachine(hubBaseUrl(), {
        name: name.trim(),
        url: url.trim(),
        pairingCode: code.trim(),
      }),
    )
      .then((machine) => {
        toastManager.add({ type: "success", title: `${machine.name} is in Fleet` });
        setName("");
        setUrl("");
        setCode("");
        onOpenChange(false);
        onAdded(machine.name);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>
            A machine already running Magnesium. The hub keeps it in its list and connects to it;
            nothing else changes there. In Kubernetes, add a Magnesium pod or attach a workload's
            machine from Settings → Connections instead.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Field
              label="Name in Fleet (a-z, 0-9 and -)"
              value={name}
              onChange={setName}
              placeholder="gpu-c"
              disabled={busy}
            />
            <Field
              label="Its address"
              value={url}
              onChange={setUrl}
              placeholder="https://gpu-c.example:3773"
              disabled={busy}
            />
            <Field
              label="Pairing code"
              value={code}
              onChange={setCode}
              placeholder="PAIRCODE"
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{CODE_HINT}</p>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy || !ready} onClick={submit}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A new pairing code for a machine the hub lost access to; its old token stops working. */
export function GiveAccessAgainDialog({
  machine,
  open,
  onOpenChange,
}: {
  readonly machine: FleetMachine;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = machine.name ?? machine.label;
  const submit = () => {
    setBusy(true);
    setError(null);
    runHubRequest(giveHubAccess(hubBaseUrl(), name, { pairingCode: code.trim() }))
      .then(() => {
        toastManager.add({ type: "success", title: `The hub has access to ${name} again` });
        setCode("");
        onOpenChange(false);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Give the hub access to {name} again</DialogTitle>
          <DialogDescription>
            With a new pairing code from {name}, the hub gets a fresh token there, and the one it
            replaces stops working.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Field
              label="Pairing code"
              value={code}
              onChange={setCode}
              placeholder="PAIRCODE"
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">{CODE_HINT}</p>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy || code.trim() === ""} onClick={submit}>
            {busy ? "Giving access…" : "Give access"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Takes a machine off the hub's list; the hub's session on it ends. */
export function ForgetMachineDialog({
  machine,
  open,
  onOpenChange,
  onForgotten,
}: {
  readonly machine: FleetMachine;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onForgotten: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const name = machine.name ?? machine.label;
  const forget = () => {
    setBusy(true);
    runHubRequest(forgetHubMachine(hubBaseUrl(), name))
      .then(() => {
        toastManager.add({ type: "success", title: `Forgot ${name}` });
        onOpenChange(false);
        onForgotten();
      })
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: `${name} wasn't forgotten`,
          description: messageOf(cause),
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Forget {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {name} leaves the hub's list, and the hub's access to it ends there too.
          </AlertDialogDescription>
          <p className="text-sm text-muted-foreground">
            Magnesium keeps running on {name} with its threads. Add it again with a new pairing
            code.
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={forget}>
            Forget
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
