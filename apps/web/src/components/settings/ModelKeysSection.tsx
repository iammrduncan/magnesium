// magnesium: model keys the hub holds for Magnesium as a whole, handed to spokes by name (goal 25, D57)
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
