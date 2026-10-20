// magnesium: Profiles, made and managed in the app (goal 34, D65, D67)
import {
  type DeletedProfile,
  parseProfileInstanceId,
  PROFILE_HARNESS_LABELS,
  PROFILE_TRASH_DAYS,
  type ProfileDetail,
  type ProfileList,
  type ProfileSummary,
} from "@magnesium/contracts";
import {
  createProfile,
  deleteProfile,
  describeProfileAsk,
  fleetRows,
  type HeldAnswer,
  newThreadTarget,
  type ProfileAsk,
  profileAsks,
  profileListLine,
  profileNameProblem,
  restoreProfile,
  waitedFor,
} from "@magnesium/web";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useFleetView } from "../fleet/fleetStore";
import { HeldBanner } from "../home/HomeCard";
import { answerHold, useHeldAnswers, useHomeView, useNow } from "../home/homeStore";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useStartProfileThread } from "../sidebar/useBots";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BrainSection,
  DeliveryPanel,
  EnvironmentSection,
  HistorySection,
  InstructionsSection,
  RunsOnSection,
  SkillsSection,
  ToolsSection,
} from "./ProfileSections";
import { runChange, useProfileDetail, useProfileList } from "./profilesData";

export const PROFILE_TABS = [
  "instructions",
  "skills",
  "tools",
  "environment",
  "runs-on",
  "brain",
  "history",
] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

const TAB_LABEL: Record<ProfileTab, string> = {
  instructions: "Instructions",
  skills: "Skills",
  tools: "Tools",
  environment: "Environment",
  "runs-on": "Runs on",
  brain: "Brain",
  history: "History",
};

const LINE_TONE = {
  error: "text-destructive-foreground",
  warning: "text-warning-foreground",
  muted: "text-muted-foreground",
} as const;

/** A profile's initials on its accent, as the picker shows it. */
function ProfileAvatar({
  profile,
  size,
}: {
  readonly profile: ProfileSummary;
  readonly size: "sm" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        size === "sm" ? "size-6 text-2xs" : "size-9 text-xs",
      )}
      style={{ backgroundColor: profile.accentColor }}
    >
      {profile.avatar}
    </span>
  );
}

function NewProfileDialog({
  open,
  onOpenChange,
  taken,
  copyOf,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly taken: ReadonlyArray<string>;
  /** A profile to start from, as Duplicate does. */
  readonly copyOf: ProfileSummary | null;
  readonly onCreated: (name: string) => void;
}) {
  const [start, setStart] = useState<"blank" | "copy">(copyOf === null ? "blank" : "copy");
  const [name, setName] = useState(copyOf === null ? "" : `${copyOf.name}-copy`);
  const [description, setDescription] = useState(copyOf?.description ?? "");
  const [busy, setBusy] = useState(false);
  const problem = name === "" ? undefined : profileNameProblem(name, taken);
  const create = async () => {
    setBusy(true);
    const ok = await runChange(
      (url) =>
        createProfile(url, {
          name,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
          ...(start === "copy" && copyOf !== null ? { copyOf: copyOf.name } : {}),
        }),
      `${name} created`,
    );
    setBusy(false);
    if (ok) onCreated(name);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {/* Layout-free, so the popup's header, panel and footer stay its direct children. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (name !== "" && problem === undefined) void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New profile</DialogTitle>
            <DialogDescription>
              It runs on every machine, on Claude Code, fenced. Narrow any of it once it exists.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {copyOf !== null ? (
                <ToggleGroup
                  aria-label="Start from"
                  variant="segmented"
                  value={[start]}
                  onValueChange={(next) => {
                    const chosen = next[0];
                    if (chosen === "blank" || chosen === "copy") setStart(chosen);
                  }}
                >
                  <Toggle value="blank">Blank</Toggle>
                  <Toggle value="copy">Copy of {copyOf.displayName}</Toggle>
                </ToggleGroup>
              ) : null}
              <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
                Name: a-z, 0-9 and -; it can't change later
                <Input
                  value={name}
                  placeholder="scratch-b"
                  aria-invalid={problem !== undefined}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {problem ? <p className="text-xs text-destructive-foreground">{problem}</p> : null}
              <label className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
                What it does
                <Input
                  value={description}
                  placeholder="One line"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name === "" || problem !== undefined}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteProfileDialog({
  profile,
  open,
  onOpenChange,
  onDeleted,
}: {
  readonly profile: ProfileSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Its threads, on every machine; read only while the dialog is open.
  const threads = useThreadShells(open).filter(
    (shell) =>
      shell.archivedAt === null &&
      parseProfileInstanceId(shell.providerInstanceId)?.profile === profile.name,
  );
  const named = threads.slice(0, 5).map((shell) => shell.title);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its machines stop offering it.{" "}
            {threads.length === 0
              ? "No thread runs on it."
              : `${threads.length === 1 ? "1 thread runs" : `${threads.length} threads run`} on it: ${named.join(", ")}${threads.length > named.length ? `, and ${threads.length - named.length} more` : ""}. They keep their history and can move to another profile.`}{" "}
            You can restore it, with its history, for {PROFILE_TRASH_DAYS} days.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void runChange(
                (url) => deleteProfile(url, profile.name),
                `${profile.displayName} deleted`,
                () =>
                  void runChange(
                    (url) => restoreProfile(url, profile.name),
                    `${profile.displayName} restored`,
                  ).then(onDeleted),
              ).then((ok) => {
                setBusy(false);
                if (ok) onDeleted();
              });
            }}
          >
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** An agent's ask, answered here or on Home: the same card, with the same Undo. */
function ProfileAskBanner({
  ask,
  held,
  now,
}: {
  readonly ask: ProfileAsk;
  readonly held: HeldAnswer | undefined;
  readonly now: number;
}) {
  const locked = !ask.reachable || held !== undefined;
  const respond = (approve: boolean) =>
    answerHold.hold(
      ask.key,
      { _tag: "profile-request", requestId: ask.body.requestId, approve },
      approve ? "Approving" : "Rejecting",
    );
  return (
    <Alert variant="warning">
      <AlertTitle>{describeProfileAsk(ask.body)}</AlertTitle>
      <AlertDescription>
        <span>
          {ask.body.summary} · {ask.machine.label} · {waitedFor(ask.since, now)} · also on Home
        </span>
        <pre className="max-h-60 overflow-auto rounded-lg bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">
          {ask.body.preview}
        </pre>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={locked} onClick={() => respond(false)}>
            Reject
          </Button>
          <Button size="sm" disabled={locked} onClick={() => respond(true)}>
            Approve
          </Button>
        </div>
        {held !== undefined ? <HeldBanner itemKey={ask.key} held={held} now={now} /> : null}
      </AlertDescription>
    </Alert>
  );
}

/** The threads running on this profile, on every machine, newest first: the board's Used by. */
function UsedBy({ name }: { readonly name: string }) {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const labels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const using = threads
    .filter(
      (shell) =>
        shell.archivedAt === null &&
        parseProfileInstanceId(shell.providerInstanceId)?.profile === name,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8);
  return (
    <section aria-label="Used by" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Used by</h3>
      {using.length === 0 ? (
        <p className="text-sm text-muted-foreground">No thread runs on it.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {using.map((shell) => (
            <li
              key={`${shell.environmentId}:${shell.id}`}
              className="flex items-center gap-2 text-sm"
            >
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id))}
                className="min-w-0 flex-1 truncate text-foreground underline-offset-2 hover:underline"
              >
                {shell.title}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {labels.get(shell.environmentId) ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileView({
  detail,
  machines,
  tab,
  onTab,
  onChanged,
  onNewThread,
  onDuplicate,
  onDelete,
  asks,
}: {
  readonly detail: ProfileDetail;
  readonly machines: ReadonlyArray<string>;
  readonly tab: ProfileTab;
  readonly onTab: (tab: ProfileTab) => void;
  readonly onChanged: () => void;
  /** Null when it runs nowhere a thread can start now. */
  readonly onNewThread: (() => void) | null;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  /** Agents' asks about this profile, as banners. */
  readonly asks: ReactNode;
}) {
  const profile = detail.summary;
  const refused = profile.status === "refused";
  const errors = profile.issues.filter((issue) => issue.level === "error");
  const counts: Partial<Record<ProfileTab, number>> = {
    skills: detail.skills.length,
    tools: detail.mcpServers.length - 1,
    environment: new Set([...detail.env, ...detail.mcpServers.flatMap((server) => server.secrets)])
      .size,
  };
  const section = { detail, onChanged };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <ProfileAvatar profile={profile} size="lg" />
        <div className="min-w-56 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-base font-semibold text-foreground">{profile.displayName}</h2>
            <code className="text-xs text-muted-foreground">{profile.name}</code>
            <Badge variant={refused ? "error" : "success"} size="sm">
              {refused ? "Refused" : "Ready"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {[
              profile.description,
              detail.harnesses.map((harness) => PROFILE_HARNESS_LABELS[harness]).join(" and "),
              `${profile.sandbox} by default`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {onNewThread !== null ? (
          <Button size="sm" onClick={onNewThread}>
            New thread
          </Button>
        ) : null}
        {detail.editable ? (
          <>
            <Button size="sm" variant="outline" onClick={onDuplicate}>
              Duplicate
            </Button>
            <Button size="sm" variant="destructive-outline" onClick={onDelete}>
              Delete…
            </Button>
          </>
        ) : null}
      </header>
      {!detail.editable ? (
        <Alert variant="info">
          <AlertTitle>From the hub</AlertTitle>
          <AlertDescription>
            This machine's profiles come from the hub: change them there.
          </AlertDescription>
        </Alert>
      ) : null}
      {asks}
      {refused ? (
        <Alert variant="error">
          <AlertTitle>Refused</AlertTitle>
          <AlertDescription>
            {errors.map((issue) => `${issue.file}: ${issue.message}`).join(" ")} Its machines keep
            running the last version that passed.
          </AlertDescription>
        </Alert>
      ) : null}
      {/* The boards' layout: the sections, then Delivery and Used by in their own column. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Tabs className="min-w-0" value={tab} onValueChange={(value) => onTab(value as ProfileTab)}>
          <TabsList aria-label="Profile sections">
            {PROFILE_TABS.map((value) => (
              <TabsTab key={value} value={value}>
                {TAB_LABEL[value]}
                {counts[value] !== undefined ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {counts[value]}
                  </span>
                ) : null}
              </TabsTab>
            ))}
          </TabsList>
          <TabsPanel value="instructions">
            <InstructionsSection {...section} />
          </TabsPanel>
          <TabsPanel value="skills">
            <SkillsSection {...section} />
          </TabsPanel>
          <TabsPanel value="tools">
            <ToolsSection {...section} />
          </TabsPanel>
          <TabsPanel value="environment">
            <EnvironmentSection key={detail.version} {...section} />
          </TabsPanel>
          <TabsPanel value="runs-on">
            {/* Read again after each save: its fields start from what's saved. */}
            <RunsOnSection key={detail.version} {...section} machines={machines} />
          </TabsPanel>
          <TabsPanel value="brain">
            <BrainSection {...section} />
          </TabsPanel>
          <TabsPanel value="history">
            <HistorySection {...section} />
          </TabsPanel>
        </Tabs>
        <aside className="flex min-w-0 flex-col gap-6">
          <DeliveryPanel {...section} />
          <UsedBy name={profile.name} />
        </aside>
      </div>
    </div>
  );
}

/** Profiles opens here, at every width (D68): how many, the agents' asks, then a row each. */
function ProfileListScreen({
  list,
  deleted,
  error,
  asks,
  onOpen,
  onNew,
  onRestored,
}: {
  readonly list: ProfileList | null;
  readonly deleted: ReadonlyArray<DeletedProfile>;
  readonly error: string | null;
  readonly asks: ReactNode;
  readonly onOpen: (name: string) => void;
  readonly onNew: () => void;
  readonly onRestored: (name: string) => void;
}) {
  const profiles = list?.profiles ?? [];
  const homeItems = useHomeView().items;
  const asking = new Set(profileAsks(homeItems).map((ask) => ask.body.target));
  const refused = profiles.filter((profile) => profile.status === "refused").length;
  const askCount = profileAsks(homeItems).length;
  const counts = [
    `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`,
    ...(askCount > 0 ? [`${askCount} ${askCount === 1 ? "asks" : "ask"} you`] : []),
    ...(refused > 0 ? [`${refused} refused`] : []),
  ].join(" · ");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold text-foreground">Profiles</h2>
          {list !== null ? <p className="text-sm text-muted-foreground">{counts}</p> : null}
        </div>
        {list === null || list.machine === "hub" ? (
          <Button size="icon" variant="outline" aria-label="New profile" onClick={onNew}>
            <PlusIcon />
          </Button>
        ) : null}
      </header>
      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
      {list === null && error === null ? (
        <p className="text-sm text-muted-foreground">Reading the hub's profiles…</p>
      ) : null}
      {asks}
      {list !== null && profiles.length === 0 ? (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-sm text-muted-foreground">
            No profiles yet. A profile is an agent you set up once: its instructions, tools and
            where it runs.
          </p>
          <Button size="sm" onClick={onNew}>
            Create a profile
          </Button>
        </div>
      ) : null}
      {profiles.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {profiles.map((profile) => {
            const line = profileListLine(profile, list?.pushes ?? []);
            return (
              <li key={profile.name}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => onOpen(profile.name)}
                >
                  <ProfileAvatar profile={profile} size="lg" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {profile.displayName}
                    </span>
                    <span className={cn("truncate text-xs", LINE_TONE[line.tone])}>
                      {line.text}
                    </span>
                  </span>
                  {asking.has(profile.name) ? (
                    <span
                      role="img"
                      aria-label="An agent asks to change it"
                      className="size-2 shrink-0 rounded-full bg-warning"
                    />
                  ) : null}
                  <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {deleted.length > 0 ? (
        <section aria-label="Deleted profiles" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Deleted
          </h3>
          <ul className="flex flex-col gap-1">
            {deleted.map((profile) => (
              <li key={`${profile.name}-${profile.deletedAt}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-muted-foreground line-through">
                    {profile.displayName}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Until{" "}
                    {new Date(profile.expiresAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void runChange(
                      (url) => restoreProfile(url, profile.name),
                      `${profile.displayName} restored`,
                    ).then((ok) => ok && onRestored(profile.name))
                  }
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function ProfilesPage() {
  const search = useSearch({ from: "/profiles" });
  const navigate = useNavigate({ from: "/profiles" });
  const { list, deleted, error, refresh } = useProfileList();
  const profiles = useMemo(() => list?.profiles ?? [], [list]);
  // No name opens the list; a profile opens on its own.
  const selectedName = search.name ?? null;
  const tab = search.tab ?? "instructions";
  const { detail, error: detailError, refresh: refreshDetail } = useProfileDetail(selectedName);
  const fleet = useFleetView();
  const fleetMachines = useMemo(() => fleetRows(fleet.machines), [fleet.machines]);
  const machines = useMemo(
    () => fleetMachines.flatMap((machine) => (machine.name === null ? [] : [machine.name])),
    [fleetMachines],
  );
  const serverConfigs = useServerConfigs();
  const startProfileThread = useStartProfileThread();
  const [chosenDialog, setDialog] = useState<"new" | "copy" | "delete" | null>(null);
  const dialog = chosenDialog ?? (search.new === true ? "new" : null);
  const selected = profiles.find((profile) => profile.name === selectedName) ?? null;
  const homeItems = useHomeView().items;
  const asks = useMemo(() => profileAsks(homeItems), [homeItems]);
  const held = useHeldAnswers();
  const now = useNow([...held.values()].some((answer) => answer.state === "holding"));
  const askBanners = (shown: ReadonlyArray<ProfileAsk>) =>
    shown.map((ask) => (
      <ProfileAskBanner key={ask.key} ask={ask} held={held.get(ask.key)} now={now} />
    ));

  const select = (name: string, nextTab: ProfileTab = tab) =>
    void navigate({ search: { name, tab: nextTab } });
  const closeDialog = () => {
    setDialog(null);
    if (search.new === true) {
      void navigate({
        search: ({ name, tab }) => ({
          ...(name === undefined ? {} : { name }),
          ...(tab === undefined ? {} : { tab }),
        }),
        replace: true,
      });
    }
  };
  const changed = () => {
    void refresh();
    void refreshDetail();
  };
  // An ask that leaves Home was answered: read the profiles again, so an approved change shows.
  const askKeys = asks.map((ask) => ask.key).join(" ");
  const lastAskKeys = useRef(askKeys);
  useEffect(() => {
    const current = new Set(askKeys.split(" "));
    const gone = lastAskKeys.current.split(" ").some((key) => key !== "" && !current.has(key));
    lastAskKeys.current = askKeys;
    if (!gone) return;
    void refresh();
    void refreshDetail();
  }, [askKeys, refresh, refreshDetail]);

  const threadTarget =
    detail === null
      ? null
      : newThreadTarget({
          detail,
          machines: fleetMachines,
          hasInstance: (environmentId, instanceId) =>
            serverConfigs
              .get(EnvironmentId.make(environmentId))
              ?.providers.some((provider) => provider.instanceId === instanceId) ?? false,
        });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Profiles breadcrumb" className="min-w-0">
            {selectedName === null ? (
              <WorkspaceBreadcrumbItem current>
                <h1>Profiles</h1>
              </WorkspaceBreadcrumbItem>
            ) : (
              <>
                <WorkspaceBreadcrumbItem>
                  <Link to="/profiles" search={{}} className="hover:text-foreground">
                    Profiles
                  </Link>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current>
                  <h1 className="truncate">{detail?.summary.displayName ?? selectedName}</h1>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex p-4 sm:p-6">
            {selectedName === null ? (
              <ProfileListScreen
                list={list}
                deleted={deleted}
                error={error}
                asks={askBanners(asks)}
                onOpen={(name) => select(name, "instructions")}
                onNew={() => setDialog("new")}
                onRestored={(name) => {
                  void refresh();
                  select(name, "instructions");
                }}
              />
            ) : detail !== null ? (
              <ProfileView
                key={detail.summary.name}
                detail={detail}
                machines={machines}
                tab={tab}
                onTab={(next) =>
                  void navigate({ search: { name: selectedName, tab: next }, replace: true })
                }
                onChanged={changed}
                onNewThread={
                  threadTarget === null
                    ? null
                    : () =>
                        void startProfileThread(
                          EnvironmentId.make(threadTarget.environmentId),
                          threadTarget.instanceId,
                          `Could not start a thread on ${detail.summary.displayName}`,
                        )
                }
                onDuplicate={() => setDialog("copy")}
                onDelete={() => setDialog("delete")}
                asks={askBanners(asks.filter((ask) => ask.body.target === selectedName))}
              />
            ) : detailError !== null ? (
              <p className="text-sm text-destructive-foreground">{detailError}</p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
      {dialog === "new" || dialog === "copy" ? (
        <NewProfileDialog
          open
          onOpenChange={(open) => !open && closeDialog()}
          taken={[
            ...profiles.map((profile) => profile.name),
            ...deleted.map((profile) => profile.name),
          ]}
          copyOf={dialog === "copy" ? selected : null}
          onCreated={(name) => {
            closeDialog();
            void refresh();
            select(name, "instructions");
          }}
        />
      ) : null}
      {dialog === "delete" && selected !== null ? (
        <DeleteProfileDialog
          profile={selected}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            void refresh();
            void navigate({ search: {} });
          }}
        />
      ) : null}
    </SidebarInset>
  );
}
