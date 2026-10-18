// magnesium: Home, what needs you on every machine, answered in place (goal 06, the Home · desktop board)
import type { HomeItem } from "@magnesium/contracts";
import {
  describeHome,
  homeNeeds,
  homeNextRuns,
  homeRunning,
  runTime,
  waitedFor,
} from "@magnesium/web";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { STATUS_SHAPE_TONE, StatusShape } from "../sidebar/StatusShape";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HomeCard, HomeGlanceRow, type HomeZoom, ThreadLink } from "./HomeCard";
import { useHeldAnswers, useHomeView } from "./homeStore";

const ZOOM_STORAGE_KEY = "magnesium:home-zoom";
/** Next runs beside the feed; the Schedule page (goal 11) lists them all. */
const NEXT_RUNS_SHOWN = 5;
const HomeZoomSchema = Schema.Literals(["glance", "cards", "detail"]);

/**
 * The clock for wait times and the Undo countdown: once a second while an
 * answer is held, else twice a minute. Text only, so nothing repaints between.
 */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [fast]);
  return now;
}

function RunningRow({ item, now }: { item: HomeItem; now: number }) {
  return (
    <li className="flex items-center gap-2 border-b border-border py-2 text-sm last:border-b-0">
      <StatusShape kind="working" className={STATUS_SHAPE_TONE.working} />
      <span className="min-w-0 flex-1 text-foreground">
        <ThreadLink item={item}>{item.title}</ThreadLink>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {item.machine.label} · {waitedFor(item.since, now)}
      </span>
    </li>
  );
}

const LAST_RUN_LABEL = {
  never: "",
  running: "running",
  succeeded: "ok",
  failed: "failed",
} as const;

/** One scheduled task's next run: when, what and where, and how its last run went (goal 24). */
function NextRunRow({ item, now }: { item: HomeItem; now: number }) {
  if (item.body._tag !== "scheduled") return null;
  const where = [item.projectTitle, item.machine.label].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start gap-3 border-b border-border py-2 text-sm last:border-b-0">
      <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {runTime(item.since, now)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground">
          <ThreadLink item={item}>{item.title}</ThreadLink>
        </span>
        <span className="truncate text-xs text-muted-foreground">{where}</span>
      </span>
      <span
        className={cn(
          "shrink-0 text-xs",
          item.body.lastRun === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {LAST_RUN_LABEL[item.body.lastRun]}
      </span>
    </li>
  );
}

export function HomePage() {
  const view = useHomeView();
  const held = useHeldAnswers();
  const [zoom, setZoom] = useLocalStorage<HomeZoom, HomeZoom>(
    ZOOM_STORAGE_KEY,
    "cards",
    HomeZoomSchema,
  );
  const now = useNow([...held.values()].some((answer) => answer.state === "holding"));
  const needs = useMemo(() => homeNeeds(view.items), [view.items]);
  const running = useMemo(() => homeRunning(view.items), [view.items]);
  const nextRuns = useMemo(() => homeNextRuns(view.items), [view.items]);
  // An answer on its way hides its card; Undo, or a refusal, brings it back.
  const shown = needs.filter((item) => {
    const answer = held.get(item.key);
    return answer?.state !== "sending" && answer?.state !== "sent";
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Home breadcrumb" className="min-w-0 shrink-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Home</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {describeHome(
              view.summary,
              nextRuns[0] === undefined ? null : { at: nextRuns[0].since, now },
            )}
          </span>
          <ToggleGroup
            aria-label="Zoom"
            variant="segmented"
            value={[zoom]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "glance" || next === "cards" || next === "detail") setZoom(next);
            }}
          >
            <Toggle value="glance">Glance</Toggle>
            <Toggle value="cards">Cards</Toggle>
            <Toggle value="detail">Detail</Toggle>
          </ToggleGroup>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {view.connection !== "live" ? (
              <p className="text-sm text-muted-foreground">
                {view.connection === "connecting"
                  ? "Connecting to the hub…"
                  : "Lost the hub. Reconnecting…"}
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
              <section className="flex min-w-0 flex-col gap-3" aria-labelledby="home-needs">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 id="home-needs" className="text-sm font-medium text-foreground">
                    Needs you <span className="text-muted-foreground">{shown.length}</span>
                  </h2>
                  <span className="text-xs text-muted-foreground">Oldest wait first</span>
                </div>
                {view.connection === "live" && shown.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                    {view.summary !== null && view.summary.unseen.length > 0
                      ? `Nothing needs you on the machines the hub can see. Not counted: ${view.summary.unseen.join(", ")}.`
                      : "Nothing needs you."}
                  </p>
                ) : zoom === "glance" ? (
                  <ul className="flex flex-col">
                    {shown.map((item) => (
                      <HomeGlanceRow key={item.key} item={item} now={now} />
                    ))}
                  </ul>
                ) : (
                  shown.map((item) => (
                    <HomeCard
                      key={item.key}
                      item={item}
                      zoom={zoom}
                      held={held.get(item.key)}
                      now={now}
                    />
                  ))
                )}
              </section>
              <aside className="flex min-w-0 flex-col gap-3" aria-labelledby="home-running">
                {nextRuns.length > 0 ? (
                  <section className="flex flex-col gap-3" aria-labelledby="home-next-runs">
                    <h2 id="home-next-runs" className="text-sm font-medium text-foreground">
                      Next scheduled runs
                    </h2>
                    <ul className="flex flex-col">
                      {nextRuns.slice(0, NEXT_RUNS_SHOWN).map((item) => (
                        <NextRunRow key={item.key} item={item} now={now} />
                      ))}
                    </ul>
                  </section>
                ) : null}
                <h2 id="home-running" className="text-sm font-medium text-foreground">
                  Running now <span className="text-muted-foreground">{running.length}</span>
                </h2>
                {running.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing is working right now.</p>
                ) : (
                  <ul className="flex flex-col">
                    {running.map((item) => (
                      <RunningRow key={item.key} item={item} now={now} />
                    ))}
                  </ul>
                )}
              </aside>
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
