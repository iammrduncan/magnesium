// magnesium: managing the hub's machines in Kubernetes from the Environments list: Magnesium's own pods and machines attached inside workloads (goal 25, D59, D60); editing a pod, here and from Fleet (goal 35)
import type { HubAttached, HubMachine, HubSpoke, SpokeSpec } from "@magnesium/contracts";
import {
  applyHubSpoke,
  attachFromForm,
  attachMachine,
  describeEnvironmentKind,
  detachMachine,
  fetchHubMachines,
  listAttached,
  listGateways,
  listHubSpokes,
  listModelKeys,
  fleetRows,
  removeHubSpoke,
  runHubRequest,
  specFromForm,
} from "@magnesium/web";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

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
} from "../ui/dialog";
import { Input } from "../ui/input";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useFleetView } from "../fleet/fleetStore";

const REFRESH_MS = 15_000;

const hubUrl = () => new URL("/", window.location.origin).toString();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The hub did not answer.";

/** A dialog opened from a row's menu or from Add environment, not by its own button. */
interface Opened {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

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
  // A promise chain, not try/finally: the React Compiler can't compile a finally clause.
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    return action()
      .then(() => {
        onDone();
        return true;
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        return false;
      })
      .finally(() => setBusy(false));
  };
  return { busy, error, setError, run };
}

/**
 * Adds a Magnesium pod, or edits one (`existing`): its node, OpenCode's gateway
 * and models, and the model keys it gets. Saving applies it through its
 * gateway, which restarts the pod when anything it runs with changed.
 */
function AddSpokeDialog({
  gateways,
  keys,
  onAdded,
  open,
  setOpen,
  existing,
}: {
  readonly gateways: ReadonlyArray<HubMachine>;
  readonly keys: ReadonlyArray<string>;
  readonly onAdded: () => void;
  readonly existing?: HubSpoke | undefined;
} & Opened) {
  const [gateway, setGateway] = useState(existing?.gateway ?? gateways[0]?.name ?? "");
  const [form, setForm] = useState({
    name: existing?.name ?? "",
    node: existing?.spec.node ?? "",
    home: existing?.spec.home ?? "/home/magnesium",
    volumeSize: existing?.spec.volumeSize ?? "100Gi",
    opencodeUrl: existing?.spec.opencode?.baseUrl ?? "",
    opencodeModels: existing?.spec.opencode?.models.join(", ") ?? "",
    startNow: existing === undefined ? true : existing.spec.replicas === 1,
  });
  const [chosenKeys, setChosenKeys] = useState<ReadonlyArray<string>>(existing?.keys ?? []);
  const action = useAction(() => setOpen(false));
  const set = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));
  // A key it gets that the hub no longer holds still shows, so it can be unticked.
  const keyChoices = [...new Set([...keys, ...chosenKeys])];

  const submit = () => {
    const fromForm = specFromForm(form);
    if ("problem" in fromForm) return action.setError(fromForm.problem);
    // An edit keeps what the form doesn't show: its build, host name and whether it runs.
    const spec: SpokeSpec =
      existing === undefined
        ? fromForm
        : {
            ...fromForm,
            hostname: existing.spec.hostname,
            build: existing.spec.build,
            replicas: existing.spec.replicas,
          };
    void action
      .run(() => applyHubSpoke(hubUrl(), { gateway, spec, keys: chosenKeys }))
      .then((done) => (done ? onAdded() : undefined));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing === undefined ? "Add a machine in Kubernetes" : `Edit ${existing.name}`}
          </DialogTitle>
          <DialogDescription>
            {existing === undefined
              ? "Its gateway runs it in its namespace, on a node the namespace allows. The hub pairs with it once it is up."
              : "A Magnesium pod, through its gateway. Saving restarts the pod to take the change; its home and threads stay."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {existing === undefined ? (
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
            ) : null}
            {existing === undefined ? (
              <Field label="Name" hint="The hub's name for it, also its host name.">
                <Input
                  value={form.name}
                  onChange={set("name")}
                  placeholder="cpu-host-3"
                  spellCheck={false}
                />
              </Field>
            ) : null}
            <Field label="Node" hint="One the namespace allows.">
              <Input value={form.node} onChange={set("node")} spellCheck={false} />
            </Field>
            {existing === undefined ? (
              <>
                <Field
                  label="Home folder"
                  hint="Where its volume is mounted. A machine moved in keeps its user's home path."
                >
                  <Input value={form.home} onChange={set("home")} spellCheck={false} />
                </Field>
                <Field label="Volume size">
                  <Input value={form.volumeSize} onChange={set("volumeSize")} spellCheck={false} />
                </Field>
              </>
            ) : null}
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
            {keyChoices.length > 0 ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-xs font-medium text-foreground">
                  Model keys it gets
                </legend>
                {keyChoices.map((key) => (
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
            {existing === undefined ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.startNow}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({ ...current, startNow: checked === true }))
                    }
                  />
                  Start it now
                </label>
                <p className="text-xs text-muted-foreground">
                  Untick it to copy a machine's home into its volume before it first starts.
                </p>
              </>
            ) : null}
            {action.error ? <p className="text-xs text-destructive">{action.error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={action.busy || gateway === ""} onClick={submit}>
            {existing === undefined
              ? action.busy
                ? "Adding…"
                : "Add"
              : action.busy
                ? "Saving…"
                : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChangeBuildDialog({
  spoke,
  onChanged,
  open,
  setOpen,
}: {
  readonly spoke: HubSpoke;
  readonly onChanged: () => void;
} & Opened) {
  const [build, setBuild] = useState(spoke.spec.build ?? "");
  const action = useAction(() => setOpen(false));
  const submit = () => {
    const trimmed = build.trim();
    if (trimmed !== "" && !/^[0-9a-f]{7,40}$/.test(trimmed)) {
      return action.setError("A build is a commit, such as 6f708192a3.");
    }
    const spec: SpokeSpec = { ...spoke.spec, build: trimmed === "" ? null : trimmed };
    void action
      .run(() => applyHubSpoke(hubUrl(), { gateway: spoke.gateway, spec, keys: spoke.keys }))
      .then((done) => (done ? onChanged() : undefined));
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
  open,
  setOpen,
}: {
  readonly spoke: HubSpoke;
  readonly onRemoved: () => void;
} & Opened) {
  const [keepVolume, setKeepVolume] = useState(true);
  const action = useAction(() => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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

function GatewaySelect({
  gateways,
  value,
  onChange,
}: {
  readonly gateways: ReadonlyArray<HubMachine>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? "")}>
      <SelectTrigger size="sm" aria-label="Gateway">
        <SelectValue>{gateways.find((g) => g.name === value)?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {gateways.map((candidate) => (
          <SelectItem key={candidate.name} hideIndicator value={candidate.name}>
            {candidate.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function AttachDialog({
  gateways,
  onAttached,
  open,
  setOpen,
}: {
  readonly gateways: ReadonlyArray<HubMachine>;
  readonly onAttached: () => void;
} & Opened) {
  const [form, setForm] = useState({ gateway: gateways[0]?.name ?? "", name: "", pairingCode: "" });
  const action = useAction(() => setOpen(false));
  const submit = () => {
    const input = attachFromForm(form);
    if ("problem" in input) return action.setError(input.problem);
    void action
      .run(() => attachMachine(hubUrl(), input))
      .then((done) => (done ? onAttached() : undefined));
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attach a machine</DialogTitle>
          <DialogDescription>
            A Magnesium server inside a workload's pod, which the workload's own deploy runs. The
            hub reaches it through its namespace's gateway.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Field label="Gateway">
              <GatewaySelect
                gateways={gateways}
                value={form.gateway}
                onChange={(gateway) => setForm((current) => ({ ...current, gateway }))}
              />
            </Field>
            <Field label="Name" hint="Its MAGNESIUM_MACHINE, as the workload's deploy set it.">
              <Input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                spellCheck={false}
              />
            </Field>
            <Field
              label="Pairing code"
              hint="From its pairing Secret. Leave it empty for a machine the hub already has, such as one moved in from a spoke."
            >
              <Input
                type="password"
                value={form.pairingCode}
                onChange={(event) =>
                  setForm((current) => ({ ...current, pairingCode: event.target.value }))
                }
                autoComplete="off"
              />
            </Field>
            {action.error ? <p className="text-xs text-destructive">{action.error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={action.busy || form.gateway === ""} onClick={submit}>
            {action.busy ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DetachDialog({
  machine,
  onDetached,
  open,
  setOpen,
}: {
  readonly machine: HubAttached;
  readonly onDetached: () => void;
} & Opened) {
  const [keepAccess, setKeepAccess] = useState(false);
  const action = useAction(() => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Detach {machine.name}</DialogTitle>
          <DialogDescription>
            The hub forgets it and gives up its access. The workload keeps running; its own deploy
            takes Magnesium out of it. Attaching it again needs a new pairing code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={keepAccess}
              onCheckedChange={(checked) => setKeepAccess(checked === true)}
            />
            Keep the hub's access, to move it back where it ran before
          </label>
          {action.error ? <p className="mt-2 text-xs text-destructive">{action.error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action
                .run(() => detachMachine(hubUrl(), machine.name, keepAccess))
                .then((done) => (done ? onDetached() : undefined))
            }
          >
            {action.busy ? "Detaching…" : "Detach"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The dialog open now, with what it is about. */
type OpenDialog =
  | { readonly kind: "add-pod" }
  | { readonly kind: "attach" }
  | { readonly kind: "change-build"; readonly spoke: HubSpoke }
  | { readonly kind: "edit"; readonly spoke: HubSpoke }
  | { readonly kind: "remove"; readonly spoke: HubSpoke }
  | { readonly kind: "detach"; readonly machine: HubAttached };

interface HubMachineControls {
  readonly canManage: boolean;
  readonly gateways: ReadonlyArray<HubMachine>;
  /** By the hub's name for each machine. */
  readonly spokes: ReadonlyMap<string, HubSpoke>;
  readonly attached: ReadonlyMap<string, HubAttached>;
  readonly open: (dialog: OpenDialog) => void;
  readonly toggle: (spoke: HubSpoke) => void;
}

const HubMachineControlsContext = createContext<HubMachineControls | null>(null);

/**
 * Loads the hub's Magnesium pods, attached machines and gateways once for the
 * Connections page, and hosts their dialogs. Each environment row then says
 * what kind of machine it is and carries its own actions in its menu.
 */
export function HubMachineControlsProvider({
  canManage,
  children,
}: {
  readonly canManage: boolean;
  readonly children: ReactNode;
}) {
  const [spokes, setSpokes] = useState<ReadonlyArray<HubSpoke>>([]);
  const [attached, setAttached] = useState<ReadonlyArray<HubAttached>>([]);
  const [machines, setMachines] = useState<ReadonlyArray<HubMachine>>([]);
  const [gatewayNames, setGatewayNames] = useState<ReadonlyArray<string>>([]);
  const [keys, setKeys] = useState<ReadonlyArray<string>>([]);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const refresh = useCallback(async () => {
    const hub = hubUrl();
    try {
      setMachines(await runHubRequest(fetchHubMachines(hub)));
      setSpokes(await listHubSpokes(hub));
      setAttached(await listAttached(hub));
      setGatewayNames(await listGateways(hub));
    } catch {
      // Not a hub, or not now: rows show what Fleet knows.
    }
    if (canManage) setKeys(await listModelKeys(hub).catch(() => []));
  }, [canManage]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const gateways = useMemo(
    () => machines.filter((machine) => gatewayNames.includes(machine.name)),
    [machines, gatewayNames],
  );
  const value = useMemo<HubMachineControls>(
    () => ({
      canManage,
      gateways,
      spokes: new Map(spokes.map((spoke) => [spoke.name, spoke])),
      attached: new Map(attached.map((machine) => [machine.name, machine])),
      open: setDialog,
      toggle: (spoke) =>
        void applyHubSpoke(hubUrl(), {
          gateway: spoke.gateway,
          spec: { ...spoke.spec, replicas: spoke.spec.replicas === 1 ? 0 : 1 },
          keys: spoke.keys,
        })
          .then(() => refresh())
          .catch(() => undefined),
    }),
    [canManage, gateways, spokes, attached, refresh],
  );

  const setOpen = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const done = () => void refresh();
  return (
    <HubMachineControlsContext.Provider value={value}>
      {children}
      {dialog?.kind === "add-pod" ? (
        <AddSpokeDialog open setOpen={setOpen} gateways={gateways} keys={keys} onAdded={done} />
      ) : null}
      {dialog?.kind === "attach" ? (
        <AttachDialog open setOpen={setOpen} gateways={gateways} onAttached={done} />
      ) : null}
      {dialog?.kind === "edit" ? (
        <AddSpokeDialog
          open
          setOpen={setOpen}
          gateways={gateways}
          keys={keys}
          existing={dialog.spoke}
          onAdded={done}
        />
      ) : null}
      {dialog?.kind === "change-build" ? (
        <ChangeBuildDialog open setOpen={setOpen} spoke={dialog.spoke} onChanged={done} />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveDialog open setOpen={setOpen} spoke={dialog.spoke} onRemoved={done} />
      ) : null}
      {dialog?.kind === "detach" ? (
        <DetachDialog open setOpen={setOpen} machine={dialog.machine} onDetached={done} />
      ) : null}
    </HubMachineControlsContext.Provider>
  );
}

/**
 * What kind of machine an environment is, for its row: Magnesium's own pod,
 * attached inside a workload, the gateway, bare metal or a VM. Also the hub's
 * name for it, which the row's menu needs.
 */
export function useEnvironmentKind(environmentId: string) {
  const controls = useContext(HubMachineControlsContext);
  const fleet = useFleetView();
  const machine = useMemo(
    () => fleetRows(fleet.machines).find((row) => row.environmentId === environmentId),
    [fleet.machines, environmentId],
  );
  const name = machine?.name ?? null;
  return {
    name,
    text: describeEnvironmentKind({
      fleet: machine,
      spoke: name === null ? undefined : controls?.spokes.get(name),
      attached: name === null ? undefined : controls?.attached.get(name),
    }),
  };
}

/** A row menu's actions for a Magnesium pod, or for a machine attached in a workload. */
export function HubMachineMenuItems({ name }: { readonly name: string | null }) {
  const controls = useContext(HubMachineControlsContext);
  if (controls === null || name === null || !controls.canManage) return null;
  const spoke = controls.spokes.get(name);
  if (spoke !== undefined) {
    return (
      <>
        <MenuSeparator />
        <MenuItem onClick={() => controls.toggle(spoke)}>
          {spoke.spec.replicas === 1 ? "Stop its pod" : "Start its pod"}
        </MenuItem>
        <MenuItem onClick={() => controls.open({ kind: "edit", spoke })}>Edit…</MenuItem>
        <MenuItem onClick={() => controls.open({ kind: "change-build", spoke })}>
          Change build…
        </MenuItem>
        <MenuItem variant="destructive" onClick={() => controls.open({ kind: "remove", spoke })}>
          Remove its pod…
        </MenuItem>
      </>
    );
  }
  const machine = controls.attached.get(name);
  if (machine !== undefined) {
    return (
      <>
        <MenuSeparator />
        <MenuItem onClick={() => controls.open({ kind: "detach", machine })}>Detach…</MenuItem>
      </>
    );
  }
  return null;
}

/** In Add environment: the ways to add a machine in Kubernetes, through a gateway. */
export function KubernetesAddOptions({ onPick }: { readonly onPick: () => void }) {
  const controls = useContext(HubMachineControlsContext);
  if (controls === null || !controls.canManage || controls.gateways.length === 0) return null;
  const pick = (dialog: OpenDialog) => {
    onPick();
    controls.open(dialog);
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <p className="text-xs font-medium text-foreground">In Kubernetes, through a gateway</p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={() => pick({ kind: "add-pod" })}>
          A Magnesium pod
        </Button>
        <Button size="xs" variant="outline" onClick={() => pick({ kind: "attach" })}>
          Attach a workload's machine
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A workload whose deploy labels its route joins by itself; attach one by hand only without
        the labels.
      </p>
    </div>
  );
}

/**
 * Edit a Magnesium pod from anywhere, such as Fleet's panel: loads the pod's
 * record and the hub's keys when opened, then edits as Settings does.
 */
export function EditPodDialog({ name, open, setOpen }: { readonly name: string } & Opened) {
  const [spoke, setSpoke] = useState<HubSpoke | null>(null);
  const [keys, setKeys] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([listHubSpokes(hubUrl()), listModelKeys(hubUrl()).catch(() => [])])
      .then(([spokes, held]) => {
        if (!live) return;
        const found = spokes.find((candidate) => candidate.name === name) ?? null;
        setSpoke(found);
        setKeys(held);
        setError(found === null ? `The hub runs no pod named ${name}.` : null);
      })
      .catch((cause: unknown) => live && setError(errorMessage(cause)));
    return () => {
      live = false;
    };
  }, [open, name]);
  if (open && error !== null) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {name}</DialogTitle>
            <DialogDescription>{error}</DialogDescription>
          </DialogHeader>
        </DialogPopup>
      </Dialog>
    );
  }
  // Closed, it unmounts, so the next opening starts from the pod as it is then.
  return spoke === null || !open ? null : (
    <AddSpokeDialog
      open={open}
      setOpen={setOpen}
      gateways={[]}
      keys={keys}
      existing={spoke}
      onAdded={() => undefined}
    />
  );
}
