// magnesium: Profiles, made and managed in the app (goal 34, D65, D67)
import {
  parseProfileInstanceId,
  PROFILE_HARNESS_LABELS,
  PROFILE_TRASH_DAYS,
  type ProfileDetail,
  type ProfileSummary,
} from "@magnesium/contracts";
import {
  createProfile,
  deleteProfile,
  describeProfileAsk,
  fleetRows,
  type HeldAnswer,
  type ProfileAsk,
  profileAsks,
  profileListLine,
  profileNameProblem,
  restoreProfile,
  waitedFor,
} from "@magnesium/web";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
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
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
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
        <form
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

function ProfileView({
  detail,
  machines,
  tab,
  onTab,
  onChanged,
  onDuplicate,
  onDelete,
  asks,
}: {
  readonly detail: ProfileDetail;
  readonly machines: ReadonlyArray<string>;
  readonly tab: ProfileTab;
  readonly onTab: (tab: ProfileTab) => void;
  readonly onChanged: () => void;
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
      <div className="flex flex-wrap gap-6">
        <Tabs
          className="min-w-0 flex-[999_1_32rem]"
          value={tab}
          onValueChange={(value) => onTab(value as ProfileTab)}
        >
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
        <div className="min-w-0 flex-[1_1_16rem]">
          <DeliveryPanel {...section} />
        </div>
      </div>
    </div>
  );
}

export function ProfilesPage() {
  const search = useSearch({ from: "/profiles" });
  const navigate = useNavigate({ from: "/profiles" });
  const { list, deleted, error, refresh } = useProfileList();
  const profiles = useMemo(() => list?.profiles ?? [], [list]);
  const selectedName =
    search.name !== undefined && profiles.some((profile) => profile.name === search.name)
      ? search.name
      : (profiles[0]?.name ?? null);
  const tab = search.tab ?? "instructions";
  const { detail, error: detailError, refresh: refreshDetail } = useProfileDetail(selectedName);
  const fleet = useFleetView();
  const machines = useMemo(
    () =>
      fleetRows(fleet.machines).flatMap((machine) => (machine.name === null ? [] : [machine.name])),
    [fleet.machines],
  );
  const [chosenDialog, setDialog] = useState<"new" | "copy" | "delete" | null>(null);
  const dialog = chosenDialog ?? (search.new === true ? "new" : null);
  const selected = profiles.find((profile) => profile.name === selectedName) ?? null;
  const homeItems = useHomeView().items;
  const asks = useMemo(() => profileAsks(homeItems), [homeItems]);
  const held = useHeldAnswers();
  const now = useNow([...held.values()].some((answer) => answer.state === "holding"));
  // Asks to create a profile have none to sit on yet: they show above whichever is open.
  const shownAsks = asks.filter(
    (ask) => ask.body.target === selectedName || ask.body.kind === "create",
  );

  const select = (name: string, nextTab: ProfileTab = tab) =>
    void navigate({ search: { name, tab: nextTab }, replace: true });
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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Profiles breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Profiles</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-wrap gap-6 p-4 sm:p-6">
            <nav aria-label="Profiles" className="flex w-full flex-col gap-1 sm:w-60">
              <div className="flex items-center gap-2 px-1">
                <h2 className="flex-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Profiles
                </h2>
                {list === null || detail?.editable !== false ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="New profile"
                    onClick={() => setDialog("new")}
                  >
                    <PlusIcon />
                  </Button>
                ) : null}
              </div>
              {error ? <p className="px-1 text-sm text-destructive-foreground">{error}</p> : null}
              {list === null && error === null ? (
                <p className="px-1 text-sm text-muted-foreground">Reading the hub's profiles…</p>
              ) : null}
              {list !== null && profiles.length === 0 ? (
                <div className="flex flex-col items-start gap-2 px-1 py-2">
                  <p className="text-sm text-muted-foreground">
                    No profiles yet. A profile is an agent you set up once: its instructions, tools
                    and where it runs.
                  </p>
                  <Button size="sm" onClick={() => setDialog("new")}>
                    Create a profile
                  </Button>
                </div>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {profiles.map((profile) => {
                  const line = profileListLine(profile, list?.pushes ?? []);
                  return (
                    <li key={profile.name}>
                      <Button
                        variant={profile.name === selectedName ? "secondary" : "ghost"}
                        size="sm-multiline"
                        className="w-full justify-start"
                        aria-current={profile.name === selectedName}
                        onClick={() => select(profile.name)}
                      >
                        <ProfileAvatar profile={profile} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col items-start">
                          <span className="truncate text-sm text-foreground">
                            {profile.displayName}
                          </span>
                          <span className={cn("truncate text-xs", LINE_TONE[line.tone])}>
                            {line.text}
                          </span>
                        </span>
                        {asks.some((ask) => ask.body.target === profile.name) ? (
                          <span
                            role="img"
                            aria-label="An agent asks to change it"
                            className="size-2 shrink-0 rounded-full bg-warning"
                          />
                        ) : null}
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {deleted.length > 0 ? (
                <>
                  <h2 className="mt-3 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Deleted
                  </h2>
                  <ul className="flex flex-col gap-1">
                    {deleted.map((profile) => (
                      <li
                        key={`${profile.name}-${profile.deletedAt}`}
                        className="flex items-center gap-2 px-1"
                      >
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
                            ).then((ok) => {
                              if (ok) {
                                void refresh();
                                select(profile.name);
                              }
                            })
                          }
                        >
                          Restore
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </nav>
            <div className="flex min-w-0 flex-[999_1_40rem]">
              {detail !== null ? (
                <ProfileView
                  key={detail.summary.name}
                  detail={detail}
                  machines={machines}
                  tab={tab}
                  onTab={(next) => selectedName !== null && select(selectedName, next)}
                  onChanged={changed}
                  onDuplicate={() => setDialog("copy")}
                  onDelete={() => setDialog("delete")}
                  asks={shownAsks.map((ask) => (
                    <ProfileAskBanner key={ask.key} ask={ask} held={held.get(ask.key)} now={now} />
                  ))}
                />
              ) : detailError !== null ? (
                <p className="text-sm text-destructive-foreground">{detailError}</p>
              ) : null}
            </div>
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
          }}
        />
      ) : null}
    </SidebarInset>
  );
}
