// magnesium: model keys the hub holds for Magnesium as a whole, handed to spokes by name (goal 25, D57), replaced in place (goal 35)
import { listModelKeys, removeModelKey, setModelKey } from "@magnesium/web";
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
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const hubUrl = () => new URL("/", window.location.origin).toString();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The hub did not answer.";

function AddKeyDialog({ onAdded }: { readonly onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
      setError("Name it as agents read it, such as LITELLM_API_KEY.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setModelKey(hubUrl(), trimmed, value);
      setOpen(false);
      setName("");
      setValue("");
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Add a key</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a model key</DialogTitle>
          <DialogDescription>
            The hub keeps it and gives it, by name, to the machines you choose. It is never shown
            again; adding one with the same name replaces it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="LITELLM_API_KEY"
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Value</span>
              <Input
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
              />
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={busy || name.trim() === "" || value === ""}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A new value for a key; the pods that get it restart to take it (goal 35). */
function ReplaceKeyDialog({ name }: { readonly name: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const restarted = await setModelKey(hubUrl(), name, value);
      setOpen(false);
      setValue("");
      toastManager.add({
        type: "success",
        title: `Replaced ${name}`,
        description:
          restarted.length === 0
            ? "No pod gets it."
            : `${restarted.join(", ")} ${restarted.length === 1 ? "restarts" : "restart"} to take it.`,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>Replace</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Replace {name}</DialogTitle>
          <DialogDescription>
            The new value reaches every Magnesium pod that gets {name}, and each restarts to take
            it. It is never shown again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">New value</span>
              <Input
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                autoComplete="off"
              />
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={busy || value === ""} onClick={() => void submit()}>
            {busy ? "Replacing…" : "Replace"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The hub's model keys, by name only. Admins only; renders nothing for anyone else. */
export function ModelKeysSection({ canManage }: { readonly canManage: boolean }) {
  const [names, setNames] = useState<ReadonlyArray<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setNames(await listModelKeys(hubUrl()));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    if (canManage) void refresh();
  }, [canManage, refresh]);

  if (!canManage || names === null) return null;

  return (
    <SettingsSection title="Model keys">
      {names.map((name) => (
        <SettingsRow
          key={name}
          title={<code>{name}</code>}
          description="Held on the hub; machines get it by name."
          control={
            <div className="flex gap-1">
              <ReplaceKeyDialog name={name} />
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void removeModelKey(hubUrl(), name)
                    .then(() => refresh())
                    .catch((cause: unknown) => setError(errorMessage(cause)))
                }
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      {error ? <SettingsRow title="Couldn't change the keys" description={error} /> : null}
      <SettingsRow
        title={names.length === 0 ? "No model keys yet" : "Another key"}
        description="One key per model gateway or provider, for Magnesium as a whole."
        control={<AddKeyDialog onAdded={() => void refresh()} />}
      />
    </SettingsSection>
  );
}
