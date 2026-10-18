# Why T3 Code feels fast

**Result:** the speed comes mostly from how little data it sends and how little work the client redoes, not from one trick. A thread opens with about 75 rows instead of its whole history. Tool output and diffs are stripped from the wire and fetched on demand. Clients resume from a sequence number instead of reloading. The server coalesces bursts and buffers text to paragraph boundaries. The client keeps object identities stable and virtualises the list. Byte budgets are enforced by tests.

**Status:** read from source and docs, **not run or profiled**. Paths are in the T3 Code repo at commit `380bba36` (2026-10-13; a shallow clone, so no perf history). Ranking by impact is a judgement from how many bytes each mechanism removes and how much code and test it gets.

## Ranked summary

| #   | Mechanism                                                                               | Headline number                                                 |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Bounded snapshots and paged history                                                     | Cold open sends about 75 rows or 1 MiB                          |
| 2   | Server-side wire projection (strip tool output, diffs, handoff bodies; fetch on demand) | 600-row thread: 10.38 MB → 67 KB                                |
| 3   | Event log, snapshot plus sequence cursor resume                                         | Replay at most 128 events or 1 MiB, else fresh bounded snapshot |
| 4   | Server coalescing, batching and backpressure                                            | 50 ms windows; live buffer capped at 1,000 items or 8 MiB       |
| 5   | Paragraph-level assistant text streaming                                                | At most one update about every 400 ms                           |
| 6   | Reference-stable client state                                                           | Unchanged data returns the same object, so React skips it       |
| 7   | Virtualised transcript; `content-visibility:auto` sidebar                               | DOM size independent of thread length                           |
| 8   | Cheap animation policy                                                                  | Stepped keyframes, paused when offscreen                        |
| 9   | SQLite WAL with projection tables                                                       | UI reads small indexed tables, never replays events             |
| 10  | Perf tests with byte budgets                                                            | `test:perf:v2-wire` fails on regressions                        |

## 1. Bounded snapshots and paged history

- **What.** A thread subscription sends one snapshot of the recent window, plus a history cursor and a `hasMoreHistory` flag. Older rows come later in bounded pages over HTTP and are merged on the client.
- **Where.**
  - Policy: `apps/server/src/orchestration-v2/threadHistoryPaging.ts:13-17` (10 user turns, 75 items, 1,048,576 bytes). Older pages are 20 user turns (`:19`). Cursors are base64url JSON tied to a snapshot sequence (`:110-140`).
  - Subscribe path: `apps/server/src/ws.ts:836-870`.
  - HTTP history route: `apps/server/src/orchestration-v2/http.ts:202-227`. Client merge: `packages/client-runtime/src/state/threadHistoryMerge.ts:67-131`.
  - Query: `ProjectionStore.ts:5104-5140`, with partial indexes from migration `060_ThreadSnapshotWindowIndexes.ts`.
  - Targets documented in `docs/internals/performance-regressions.md:13-34`.
- **Who gets it.** Only clients that opt in get bounded snapshots (`ws.ts:837`); older clients still get full ones (`performance-regressions.md:20-22`).
- **Why it is fast.** Open cost is a constant, not proportional to thread length. A thread with thousands of tool rows opens as fast as a short one.
- **Copy:** define the window by user turns, return an opaque cursor, expose "load earlier". Charge each row's JSON size against a byte budget while choosing the window (`threadHistoryPaging.ts:86-104`).

## 2. Wire projection: strip bodies, fetch on demand

- **What.** Before anything leaves the server: command output becomes `outputOmitted: true` plus a failure flag; file changes drop their diff and old and new text; handoff bodies drop; large dynamic-tool inputs shrink to a one-line preview; subagent text is cut at 32 KB. Stored events stay complete. An on-demand projection (256 KB cap, no image bytes) serves the full body.
- **Where.** `apps/server/src/orchestration-v2/WireProjection.ts:14-16, 76-126, 173-201, 210-241`. Applied to live events at `ws.ts:788` and to snapshots in `ThreadStream.ts:76-79`.
- **Measured in tests** (`ThreadTransportPerformance.test.ts:23-42, 157-226`; fixture: 600 command rows with 8,192 bytes of output each):

  | Payload                                                 | Size                                              |
  | ------------------------------------------------------- | ------------------------------------------------- |
  | Full snapshot (the old baseline)                        | 10,375,121 bytes                                  |
  | Bounded, not yet stripped                               | 1,038,647 bytes                                   |
  | Bounded and stripped                                    | 67,412 bytes (budget 131,072; at most 2% of full) |
  | One live command event                                  | 8,790 → 586 bytes (budget 1,024)                  |
  | The send request (`commands.performance.test.ts:36-48`) | 10,372,184 → 522 bytes (budget 1,024)             |

  The full and bounded sizes are asserted exactly. The 67,412, 586 and 522 byte figures are recorded as comments in the tests; the tests assert only the budgets.

- **Why it is fast.** Most bytes in an agent UI are tool output nobody is looking at.
- **Copy:** this is the strongest single lesson. Give the browser a **summary** shape (type, status, title, exit code, counts) and fetch output only when a row opens. Keep failure state in the summary so a collapsed row still shows red or green.

## 3. Event log, projections, snapshot plus cursor

- **What.** One SQLite transaction commits events, projections, the command receipt and outbox effects. Subscribers hear about events only after commit. Clients hold a projection and a last sequence, and resume with `afterSequence`. Events at or below the applied sequence are ignored.
- **Where.** `EventSink.ts:214-262` (publish after commit, one lane so order holds); `commitCommand` at `:527-577` writes events, projections, the receipt and the outbox in one transaction. Resume planning `ThreadStream.ts:15-25, 98-124`; the server measures replay size before decoding (`ws.ts:879-950`). Client apply: `packages/client-runtime/src/state/threads.ts:440-560`. Cache: persisted cursor seeds resume (`:175-230`); no persist while a run is active (`:393-407`); 5-minute idle cache (`threadRetention.ts:3`).
- **Why it is fast.** Switching back to a thread, or reconnecting after a blip, costs a few events, not a snapshot. No race between snapshot and live data.
- **Copy:** the **contract** is the key: `snapshot(window)` returns a sequence, `subscribe(after)` returns events, `history(cursor)` returns older rows. Idempotent apply (ignore `seq <= applied`) and a "too far behind, send a snapshot" threshold. The full event-sourced orchestrator is not needed: a per-session append-only log with byte offsets gives the same semantics.

## 4. Coalescing, batching, backpressure

- Running tool updates collapse per tool call in a **50 ms** window, at most 512 pending. Terminal updates and any other event flush at once, so order holds (`ThreadLiveEventCoalescer.ts:18-19, 24-255`).
- Sidebar ("shell") events are grouped (512 or 50 ms), reduced to the newest per thread, and unchanged rows are dropped (`ShellStream.ts:73-100`; `ws.ts:1042-1048`).
- Each live subscription has a budget of **1,000 items or 8 MiB**. Going over fails the stream with "resume from the last received sequence" and the client resumes by cursor (`LiveStreamBudget.ts:17-18, 68-85`).
- Read-receipt writes are throttled to one per 10 s mid-turn (`ChatView.tsx:626-631`).
- WebSocket `permessage-deflate` with no size threshold (`apps/server/src/server.ts:294-299`).
- **Copy:** a 50 ms coalescing window on progress events keyed by item id; a per-subscription cap that forces a cursor resume; deflate on the socket; deltas, not full lists, for the session list.

## 5. Paragraph-level text streaming

- **What.** The default mode is `paragraph` (`packages/contracts/src/settings.ts:925, 1123-1125`). While a message streams, the server emits only the text up to the last safe markdown boundary (blank line outside a fence, a closed fence, a new list item), at most once per 400 ms. Mode `turn` emits nothing until the message ends.
- **Where.** `assistantStreaming.ts:35-132`. Client companion: `apps/web/src/markdown-incremental.ts:33-107` caches the parse up to the last closed fence and re-parses only the tail. Settled code blocks use an LRU of highlighted HTML (`ChatMarkdown.tsx:374-377`).
- **Why it is fast.** Re-parsing and re-highlighting markdown per token is a classic source of jank. Raw provider frames are not stored, so no token-level events reach the database.
- **Copy:** buffer to markdown boundaries and throttle about 400 ms in the API layer. The cost is up to a paragraph of delay, so make it a setting.

## 6. Reference-stable client state

- Reducers return the same object when nothing changed (`orchestrationV2Projection.ts:163-172`; `threads.ts` treats `next === current` as a no-op). Sidebar updates reuse unchanged rows (`shellReducer.ts:26-45, 165-174`).
- Derived state memoises per key and drops unmounted state (`threadDetail.ts:61-165`).
- Timeline rows get structural sharing before the virtual list (`MessagesTimeline.tsx:4963-5000`). Many row components are `memo`.
- React Compiler is on (`apps/web/vite.config.ts:3, 184`). Its effect is **not verified**.
- **Optimistic update: only the user's message.** It is added to local state, dispatched, and removed on failure or retired when the server holds it (`ChatView.tsx:7495-7560`, `:1750-1770`). Other mutations wait for the server (not verified for every one).
- Composer drafts: a store with a **300 ms** debounced `localStorage` write, flushed on unload (`composerDraftStore.ts:98-137`). Typing never serialises synchronously.
- Timelines held across route changes so switching threads never shows an empty list (`ChatView.logic.ts:314-330`). Desktop keeps the stream of every running thread open; sidebar prewarm is capped at 3 (`Sidebar.logic.ts:62-69`).
- **Copy:** the rule "reducers return the previous reference if nothing changed", with tests. A per-session store with a shared stream and an idle cache. The optimistic user message with a client-made id the server echoes. Debounced drafts.

## 7. Virtualisation and offscreen skipping

- Chat timeline: `@legendapp/list` with `estimatedItemSize={90}`, scroll-at-end maintenance, and `overflow-anchor:none` (`MessagesTimeline.tsx:1642-1690`). The tool log inside a turn is a second virtual list (`:3727-3745`).
- Sidebar rows use CSS `content-visibility:auto` and only near-viewport rows hold live subscriptions, with a 160 px overscan (`Sidebar.tsx:1801, 1966`; `Sidebar.logic.ts:66-90`). Row fades are limited to 40 rows per update (`Sidebar.motion.ts:7-11`).
- **Copy:** a virtual list for the transcript. Streaming plus virtualisation is the hard part: the chat view carries many scroll-state refs (`ChatView.tsx:6383-6500`), which suggests it took work. `content-visibility:auto` on the session list is a one-line win.

## 8. Animation policy

- `AGENTS.md` names "css animations causing gpu spikes" as a regression class and says "no continuously repainting animations".
- Stepped keyframes (`index.css:302-330`); shimmer text uses `steps(30)` and only under `prefers-reduced-motion: no-preference` (`:521-547`).
- `apps/web/src/lib/visibleAnimation.ts:5-60`: one IntersectionObserver plus `visibilitychange` sets a CSS variable that pauses animations offscreen or in a hidden tab.
- `backdrop-filter` blur is still used for glass surfaces (`index.css:336-434`). Its cost is **not verified**.
- **Copy:** write the rule down and add the helper. With dozens of agents, many spinning "running" marks in the list are the likely offender.

## 9. Persistence

- `node:sqlite`, WAL, `busy_timeout = 5000`, `journal_size_limit = 32 MiB` (`apps/server/src/persistence/Sqlite.ts:12-24`).
- Tables: an events table, command receipts, and projection tables for threads, runs, nodes, provider sessions, messages, plans, turn items and checkpoints (`Migrations/055_OrchestrationV2.ts`). Turn items are indexed `(thread_id, ordinal, turn_item_id)`.
- **The UI never replays events.** Snapshots and the sidebar read projection tables (`ProjectionStore.ts:5104+, 5758-5900`). The initial sidebar holds only active threads; archived threads have their own query.
- Cursor seeks must use an index, not scan history (`performance-regressions.md:52-70`).
- **Copy:** if our API keeps state, use SQLite in WAL, a precomputed summary row per session for the list, and an ordinal-indexed items table. Skip the full event-sourced orchestrator unless replay and recovery are needed.

## 10. Perf tests and budgets

`test:perf:v2-wire` runs 18 files with real projections and reducers (deterministic, before compression; not socket captures, not memory use). The rule in the docs: "Payload budgets belong in these tests so regressions fail locally."

| Budget                    | Value                             |
| ------------------------- | --------------------------------- |
| Bounded snapshot          | 131,072 bytes, at most 2% of full |
| One live command event    | 1,024 bytes                       |
| Send request              | 1,024 bytes                       |
| Cold open                 | 75 rows, about 1 MiB              |
| Resume replay             | 128 events or 1 MiB               |
| Live buffer               | 1,000 items or 8 MiB              |
| Coalescing window         | 50 ms, 512 pending                |
| Assistant stream throttle | 400 ms                            |
| Composer draft write      | 300 ms debounce                   |
| Thread cache idle TTL     | 5 minutes                         |

A lesson from the docs: older benchmarks seeded v1 data and gave "reassuring timings while missing the active transport path" (`performance-regressions.md:9-12`). Test the path users actually hit.

## What our UI needs, in priority order

1. **A sequenced API contract:** `snapshot(window, cursor)`, `subscribe(afterSequence)`, `history(cursor)`. Without it none of the cache, resume or bounded-open wins are possible.
2. **Summary and detail projections** with byte caps and an on-demand detail call.
3. **Server-side coalescing (about 50 ms) and paragraph buffering (about 400 ms)**, plus socket deflate.
4. **A stable-reference client store**, an optimistic user message that retires on ack, a shared per-session stream with an idle cache, and a virtualised transcript with sticky-bottom.
5. **Written animation rules and perf-budget tests**, from day one.
6. **SQLite WAL summary and turn tables** if our API must index the harness output itself.

**With the fork (D5),** items 1 to 3 and 6 come with the server for every thread it owns. Our own additions (rooms, fleet, schedule history on `/api/magnesium/ws`) must follow the same rules: they get none of this for free. **Open:** whether herdr exposes sequence numbers or a stream, and how it stores transcripts, is **not known**. It no longer matters: sessions started outside Magnesium stay out (D25).

## Limits of this analysis

- Nothing was run or profiled.
- `Orchestrator.ts` (11,677 lines) was not read; "decides events with no I/O" is from `AGENTS.md:137` and `docs/internals/overview.md:55-60`.
- `ChatView.tsx` (12,236 lines) and `MessagesTimeline.tsx` (5,942 lines) were only sampled around the cited lines.
- Mobile and desktop shell specifics were touched only where they affect `packages/client-runtime`.
