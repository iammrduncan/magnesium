// magnesium: Home's cards, answered in place (goal 06, the Home · desktop board)
import type {
  HomeActivity,
  HomeAnswer,
  HomeApproval,
  HomeItem,
  HomePlan,
  HomeQuestion,
  Question,
} from "@magnesium/contracts";
import { describeNeed, type HeldAnswer, waitedFor } from "@magnesium/web";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { PinIcon, PinOffIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { STATUS_SHAPE_TONE, StatusShape, type StatusShapeKind } from "../sidebar/StatusShape";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { answerHold, currentHomeWatch } from "./homeStore";

export type HomeZoom = "glance" | "cards" | "detail";

const SHAPE: Record<HomeItem["body"]["_tag"], StatusShapeKind> = {
  approval: "approval",
  question: "input",
  plan: "plan",
  failure: "failed",
  running: "working",
};

/** The thread, as a link when its machine's environment is known. */
function ThreadLink({ item, children }: { item: HomeItem; children: ReactNode }) {
  const environmentId = item.machine.environmentId;
  if (environmentId === null) return <span className="block truncate">{children}</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, item.threadId))}
      className="block truncate underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

function KindLabel({ item }: { item: HomeItem }) {
  const kind = SHAPE[item.body._tag];
  return (
    <span className={cn("flex items-center gap-1.5 text-sm font-medium", STATUS_SHAPE_TONE[kind])}>
      <StatusShape kind={kind} />
      {describeNeed(item)}
    </span>
  );
}

/** One line per need: the Glance zoom. */
export function HomeGlanceRow({ item, now }: { item: HomeItem; now: number }) {
  return (
    <li className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
      <span className="w-40 shrink-0">
        <KindLabel item={item} />
      </span>
      <span className="min-w-0 flex-1 text-sm text-foreground">
        <ThreadLink item={item}>{item.title}</ThreadLink>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {item.machine.label} · {waitedFor(item.since, now)}
        {item.reachable ? "" : " · offline"}
      </span>
    </li>
  );
}

/** A need as a card you answer in place; Detail adds the thread's latest work. */
export function HomeCard({
  item,
  zoom,
  held,
  now,
}: {
  item: HomeItem;
  zoom: Exclude<HomeZoom, "glance">;
  held: HeldAnswer | undefined;
  now: number;
}) {
  const answer = (given: HomeAnswer, label: string) => answerHold.hold(item.key, given, label);
  const locked = !item.reachable || held !== undefined;
  const togglePin = () => void currentHomeWatch()?.pin(item.key, item.pinnedAt === null);

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground",
        !item.reachable && "opacity-70",
      )}
    >
      <header className="flex items-center gap-2 text-sm">
        {item.projectTitle !== null ? (
          <span className="shrink-0 text-muted-foreground">{item.projectTitle}</span>
        ) : null}
        <span className="min-w-0 flex-1 text-foreground">
          <ThreadLink item={item}>{item.title}</ThreadLink>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {item.machine.label} · {waitedFor(item.since, now)}
        </span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={item.pinnedAt === null ? "Pin to the top" : "Unpin"}
          aria-pressed={item.pinnedAt !== null}
          onClick={togglePin}
        >
          {item.pinnedAt === null ? <PinIcon /> : <PinOffIcon />}
        </Button>
      </header>
      <KindLabel item={item} />
      {item.body._tag === "approval" ? (
        <ApprovalBody body={item.body} locked={locked} onAnswer={answer} />
      ) : item.body._tag === "question" ? (
        <QuestionBody body={item.body} locked={locked} onAnswer={answer} />
      ) : item.body._tag === "plan" ? (
        <PlanBody item={item} body={item.body} locked={locked} onAnswer={answer} />
      ) : item.body._tag === "failure" ? (
        <FailureBody item={item} message={item.body.message} locked={locked} onAnswer={answer} />
      ) : null}
      {!item.reachable ? (
        <p className="text-sm text-muted-foreground">
          {item.machine.label} is offline. Answer it when it's back.
        </p>
      ) : null}
      {held !== undefined ? <HeldBanner itemKey={item.key} held={held} now={now} /> : null}
      {zoom === "detail" ? <RecentWork itemKey={item.key} reachable={item.reachable} /> : null}
    </article>
  );
}

function HeldBanner({ itemKey, held, now }: { itemKey: string; held: HeldAnswer; now: number }) {
  if (held.state === "holding") {
    const seconds = Math.max(1, Math.ceil((held.sendsAt - now) / 1000));
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
        <span>
          {held.label} in {seconds}s
        </span>
        <Button size="xs" variant="outline" onClick={() => answerHold.undo(itemKey)}>
          Undo
        </Button>
      </div>
    );
  }
  if (held.state === "failed") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-sm">
        <span className="text-destructive">{held.error}</span>
        <Button size="xs" variant="outline" onClick={() => answerHold.dismiss(itemKey)}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
      {held.state === "sending" ? "Sending…" : "Sent."}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

function ApprovalBody({
  body,
  locked,
  onAnswer,
}: {
  body: HomeApproval;
  locked: boolean;
  onAnswer: (answer: HomeAnswer, label: string) => void;
}) {
  const respond = (decision: HomeApproval["choices"][number]["decision"], label: string) =>
    onAnswer({ _tag: "approval", requestId: body.requestId, decision }, label);
  return (
    <>
      {body.detail !== null ? (
        <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground">
          {body.detail}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">The agent sent no details.</p>
      )}
      <Actions>
        {body.choices.length > 0 ? (
          // The board's order: the rest outlined, the plain approve last and filled.
          body.choices
            .toSorted(
              (left, right) =>
                Number(left.decision === "accept") - Number(right.decision === "accept"),
            )
            .map((choice) => (
              <Button
                key={choice.decision}
                size="sm"
                variant={choice.decision === "accept" ? "default" : "outline"}
                disabled={locked}
                title={choice.warning ?? undefined}
                onClick={() =>
                  respond(
                    choice.decision,
                    choice.decision.startsWith("accept") ? "Approving" : "Declining",
                  )
                }
              >
                {choice.label}
              </Button>
            ))
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => respond("decline", "Declining")}
            >
              Decline
            </Button>
            <Button size="sm" disabled={locked} onClick={() => respond("accept", "Approving")}>
              Approve
            </Button>
          </>
        )}
      </Actions>
    </>
  );
}

const answerOf = (option: Question["options"][number]) => option.value ?? option.label;

function QuestionBody({
  body,
  locked,
  onAnswer,
}: {
  body: HomeQuestion;
  locked: boolean;
  onAnswer: (answer: HomeAnswer, label: string) => void;
}) {
  const [picked, setPicked] = useState<Record<string, ReadonlyArray<string>>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  // One question with one answer: an option answers it as soon as it is picked.
  const single = body.questions.length === 1 && body.questions[0]?.multiSelect === false;
  const send = (answers: Record<string, string | ReadonlyArray<string>>) =>
    onAnswer({ _tag: "question", requestId: body.requestId, answers }, "Answering");

  const answers = Object.fromEntries(
    body.questions.flatMap((question) => {
      const text = typed[question.id]?.trim() ?? "";
      if (text) return [[question.id, text]];
      const chosen = picked[question.id] ?? [];
      if (chosen.length === 0) return [];
      return [[question.id, question.multiSelect ? chosen : chosen[0]!]];
    }),
  );
  const complete = body.questions.every((question) => answers[question.id] !== undefined);

  return (
    <div className="flex flex-col gap-4">
      {body.questions.map((question) => (
        <div key={question.id} className="flex flex-col gap-2">
          <p className="text-sm text-foreground">{question.question}</p>
          {question.options.map((option) => {
            const value = answerOf(option);
            const selected = (picked[question.id] ?? []).includes(value);
            return (
              <button
                key={value}
                type="button"
                disabled={locked}
                aria-pressed={selected}
                onClick={() => {
                  if (single) {
                    send({ [question.id]: value });
                    return;
                  }
                  setPicked((current) => {
                    const chosen = current[question.id] ?? [];
                    const next = question.multiSelect
                      ? chosen.includes(value)
                        ? chosen.filter((entry) => entry !== value)
                        : [...chosen, value]
                      : [value];
                    return { ...current, [question.id]: next };
                  });
                }}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-60",
                  selected && "border-primary bg-accent",
                )}
              >
                <span className="font-medium text-foreground">{option.label}</span>
                {option.description !== null ? (
                  <span className="text-muted-foreground">{option.description}</span>
                ) : null}
              </button>
            );
          })}
          {question.allowsText ? (
            <Input
              placeholder={question.options.length > 0 ? "Or type an answer" : "Type an answer"}
              value={typed[question.id] ?? ""}
              disabled={locked}
              onChange={(event) =>
                setTyped((current) => ({ ...current, [question.id]: event.target.value }))
              }
            />
          ) : null}
        </div>
      ))}
      {!single || body.questions.some((question) => question.allowsText) ? (
        <Actions>
          <Button size="sm" disabled={locked || !complete} onClick={() => send(answers)}>
            Answer
          </Button>
        </Actions>
      ) : null}
    </div>
  );
}

function PlanBody({
  item,
  body,
  locked,
  onAnswer,
}: {
  item: HomeItem;
  body: HomePlan;
  locked: boolean;
  onAnswer: (answer: HomeAnswer, label: string) => void;
}) {
  return (
    <>
      <div className="max-h-72 overflow-y-auto rounded-lg bg-muted px-3 py-2">
        <ChatMarkdown
          text={body.markdown}
          cwd={undefined}
          environmentId={item.machine.environmentId ?? undefined}
          isStreaming={false}
          headingLevelOffset={3}
        />
      </div>
      {body.truncated ? (
        <p className="text-xs text-muted-foreground">
          Cut short here. Open the thread for the whole plan.
        </p>
      ) : null}
      <Actions>
        <OpenThreadButton item={item} label="Refine" />
        <Button
          size="sm"
          disabled={locked}
          onClick={() => onAnswer({ _tag: "plan", planId: body.planId }, "Implementing")}
        >
          Implement
        </Button>
      </Actions>
    </>
  );
}

function FailureBody({
  item,
  message,
  locked,
  onAnswer,
}: {
  item: HomeItem;
  message: string | null;
  locked: boolean;
  onAnswer: (answer: HomeAnswer, label: string) => void;
}) {
  return (
    <>
      <p className="text-sm text-foreground">{message ?? "The last turn failed."}</p>
      <Actions>
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => onAnswer({ _tag: "settle" }, "Settling")}
        >
          Settle
        </Button>
        <OpenThreadButton item={item} label="Open thread" />
      </Actions>
    </>
  );
}

function OpenThreadButton({ item, label }: { item: HomeItem; label: string }) {
  const environmentId = item.machine.environmentId;
  if (environmentId === null) {
    return (
      <Button size="sm" variant="outline" disabled>
        {label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(environmentId, item.threadId))}
        />
      }
    >
      {label}
    </Button>
  );
}

/** The thread's latest tool output, fetched when the card opens in Detail. */
function RecentWork({ itemKey, reachable }: { itemKey: string; reachable: boolean }) {
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "loaded"; readonly activities: ReadonlyArray<HomeActivity> }
    | { readonly status: "failed"; readonly error: string }
  >({ status: "loading" });

  useEffect(() => {
    if (!reachable) return;
    let current = true;
    const watch = currentHomeWatch();
    const request =
      watch?.detail(itemKey) ?? Promise.reject(new Error("Not connected to the hub."));
    request.then(
      (detail) => {
        if (current) setState({ status: "loaded", activities: detail.activities });
      },
      (error: unknown) => {
        if (current) {
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : "Could not load it.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [itemKey, reachable]);

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">Recent work</h3>
      {!reachable ? (
        <p className="text-sm text-muted-foreground">Shown when its machine is back.</p>
      ) : state.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.status === "failed" ? (
        <p className="text-sm text-destructive">{state.error}</p>
      ) : state.activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tool output in this turn yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {state.activities.map((activity) => (
            <li key={`${activity.at}-${activity.label}`} className="flex flex-col gap-1">
              <span className="text-sm text-foreground">{activity.label}</span>
              {activity.detail !== null ? (
                <pre className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                  {activity.detail}
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
