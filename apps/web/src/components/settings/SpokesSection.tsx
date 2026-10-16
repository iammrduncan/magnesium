// magnesium: the hub's machines in Kubernetes, run through a namespace's gateway (goal 25)
import type { HubMachine, HubSpoke, SpokeSpec } from "@magnesium/contracts";
import {
  applyHubSpoke,
  describeSpoke,
  fetchHubMachines,
  listGateways,
  listHubSpokes,
  listModelKeys,
  removeHubSpoke,
  runHubRequest,
  specFromForm,
} from "@magnesium/web";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow } from "./EnvironmentRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const REFRESH_MS = 15_000;

const hubUrl = () => new URL("/", window.location.origin).toString();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The hub did not answer.";

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** A dialog that runs one action, showing the hub's refusal in place. */
function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function AddSpokeDialog({
  gateways,
  keys,
  onAdded,
}: {
  readonly gateways: ReadonlyArray<HubMachine>;
  readonly keys: ReadonlyArray<string>;
  readonly onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [gateway, setGateway] = useState(gateways[0]?.name ?? "");
  const [form, setForm] = useState({
    name: "",
    node: "",
    home: "/home/magnesium",
    volumeSize: "100Gi",
    opencodeUrl: "",
    opencodeModels: "",
  });
  const [chosenKeys, setChosenKeys] = useState<ReadonlyArray<string>>([]);
  const action = useAction(() => setOpen(false));
  const set = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = () => {
    const spec = specFromForm(form);
    if ("problem" in spec) return action.setError(spec.problem);
    void action
      .run(() => applyHubSpoke(hubUrl(), { gateway, spec, keys: chosenKeys }))
      .then((done) => (done ? onAdded() : undefined));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Add a machine</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a machine in Kubernetes</DialogTitle>
          <DialogDescription>
            Its gateway runs it in its namespace, on a node the namespace allows. The hub pairs with
            it once it is up.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Field label="Gateway">
              <Select value={gateway} onValueChange={(value) => setGateway(value ?? "")}>
                <SelectTrigger size="sm" aria-label="Gateway">
                  <SelectValue>
                    {gateways.find((g) => g.name === gateway)?.label ?? gateway}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {gateways.map((candidate) => (
                    <SelectItem key={candidate.name} hideIndicator value={candidate.name}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Name" hint="The hub's name for it, also its host name.">
              <Input
                value={form.name}
                onChange={set("name")}
                placeholder="cpu-host-3"
                spellCheck={false}
              />
            </Field>
            <Field label="Node" hint="One the namespace allows.">
              <Input value={form.node} onChange={set("node")} spellCheck={false} />
            </Field>
            <Field
              label="Home folder"
              hint="Where its volume is mounted. A machine moved in keeps its user's home path."
            >
              <Input value={form.home} onChange={set("home")} spellCheck={false} />
            </Field>
            <Field label="Volume size">
              <Input value={form.volumeSize} onChange={set("volumeSize")} spellCheck={false} />
            </Field>
            <Field label="OpenCode gateway" hint="Optional: a LiteLLM or OpenAI-compatible URL.">
              <Input value={form.opencodeUrl} onChange={set("opencodeUrl")} spellCheck={false} />
            </Field>
            {form.opencodeUrl.trim() !== "" ? (
              <Field label="OpenCode models" hint="Comma-separated; the first is the default.">
                <Input
                  value={form.opencodeModels}
                  onChange={set("opencodeModels")}
                  spellCheck={false}
                />
              </Field>
            ) : null}
            {keys.length > 0 ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-xs font-medium text-foreground">
                  Model keys it gets
                </legend>
                {keys.map((key) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={chosenKeys.includes(key)}
                      onCheckedChange={(checked) =>
                        setChosenKeys((current) =>
                          checked ? [...current, key] : current.filter((other) => other !== key),
                        )
                      }
                    />
                    <code>{key}</code>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {action.error ? <p className="text-xs text-destructive">{action.error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={action.busy || gateway === ""} onClick={submit}>
            {action.busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChangeBuildDialog({
  spoke,
  onChanged,
}: {
  readonly spoke: HubSpoke;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [build, setBuild] = useState(spoke.spec.build ?? "");
  const action = useAction(() => setOpen(false));
  const submit = () => {
    const trimmed = build.trim();
    if (trimmed !== "" && !/^[0-9a-f]{7,40}$/.test(trimmed)) {
      return action.setError("A build is a commit, such as d05b2baa70.");
    }
    const spec: SpokeSpec = { ...spoke.spec, build: trimmed === "" ? null : trimmed };
    void action
      .run(() => applyHubSpoke(hubUrl(), { gateway: spoke.gateway, spec, keys: spoke.keys }))
      .then((done) => (done ? onChanged() : undefined));
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>Change build</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change {spoke.name}'s build</DialogTitle>
          <DialogDescription>
            It restarts on the new build. Leave it blank to run its gateway's own build.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Field label="Build">
            <Input
              value={build}
              onChange={(event) => setBuild(event.target.value)}
              spellCheck={false}
            />
          </Field>
          {action.error ? <p className="mt-2 text-xs text-destructive">{action.error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={action.busy} onClick={submit}>
            {action.busy ? "Changing…" : "Change build"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RemoveDialog({
  spoke,
  onRemoved,
}: {
  readonly spoke: HubSpoke;
  readonly onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [keepVolume, setKeepVolume] = useState(true);
  const action = useAction(() => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="ghost" />}>Remove</DialogTrigger>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {spoke.name}</DialogTitle>
          <DialogDescription>
            Its gateway stops it and removes it from the namespace. With its home kept, adding it
            again brings back its projects, threads and logins.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={keepVolume}
              onCheckedChange={(checked) => setKeepVolume(checked === true)}
            />
            Keep its home
          </label>
          {action.error ? <p className="mt-2 text-xs text-destructive">{action.error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action
                .run(() => removeHubSpoke(hubUrl(), { name: spoke.name, keepVolume }))
                .then((done) => (done ? onRemoved() : undefined))
            }
          >
            {action.busy
              ? "Removing…"
              : keepVolume
                ? "Remove, keep its home"
                : "Remove with its home"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Machines the hub runs in Kubernetes through a gateway. Shown on a hub that
 * has a gateway or runs a spoke; changing anything needs an admin session.
 */
export function SpokesSection({ canManage }: { readonly canManage: boolean }) {
  const [spokes, setSpokes] = useState<ReadonlyArray<HubSpoke>>([]);
  const [machines, setMachines] = useState<ReadonlyArray<HubMachine>>([]);
  const [gatewayNames, setGatewayNames] = useState<ReadonlyArray<string>>([]);
  const [keys, setKeys] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const hub = hubUrl();
    try {
      setMachines(await runHubRequest(fetchHubMachines(hub)));
    } catch {
      // Not a hub: nothing to show.
    }
    try {
      setSpokes(await listHubSpokes(hub));
      setGatewayNames(await listGateways(hub));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
    if (canManage) setKeys(await listModelKeys(hub).catch(() => []));
  }, [canManage]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const gateways = machines.filter((machine) => gatewayNames.includes(machine.name));
  if (spokes.length === 0 && gateways.length === 0) return null;

  const toggle = (spoke: HubSpoke) =>
    applyHubSpoke(hubUrl(), {
      gateway: spoke.gateway,
      spec: { ...spoke.spec, replicas: spoke.spec.replicas === 1 ? 0 : 1 },
      keys: spoke.keys,
    })
      .then(() => refresh())
      .catch((cause: unknown) => setError(errorMessage(cause)));

  return (
    <SettingsSection title="Machines in Kubernetes">
      {spokes.map((spoke) => (
        <EnvironmentRow
          key={spoke.name}
          kind="server"
          label={spoke.name}
          subtitle={<span className="block truncate">{describeSpoke(spoke)}</span>}
          dimmed={spoke.spec.replicas === 0}
        >
          {canManage ? (
            <>
              <Button size="xs" variant="ghost" onClick={() => void toggle(spoke)}>
                {spoke.spec.replicas === 1 ? "Stop" : "Start"}
              </Button>
              <ChangeBuildDialog spoke={spoke} onChanged={() => void refresh()} />
              <RemoveDialog spoke={spoke} onRemoved={() => void refresh()} />
            </>
          ) : null}
        </EnvironmentRow>
      ))}
      {error ? <SettingsRow title="Couldn't load them" description={error} /> : null}
      {canManage ? (
        gateways.length > 0 ? (
          <SettingsRow
            title={spokes.length === 0 ? "No machines in Kubernetes yet" : "Another machine"}
            description="Run a machine server as a pod, through a namespace's gateway."
            control={
              <AddSpokeDialog gateways={gateways} keys={keys} onAdded={() => void refresh()} />
            }
          />
        ) : null
      ) : (
        <SettingsRow
          title="Admin access needed"
          description="Sign in to the hub with an admin link to add, change or remove these."
        />
      )}
    </SettingsSection>
  );
}
