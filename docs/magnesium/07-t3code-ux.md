# T3 Code: UX, layout and visual language

**Result:** T3 Code is a quiet, three-part layout: a flat **inbox of threads** on the left, **one conversation** in the middle (46rem wide, a glass composer pinned below), and a **tabbed right panel** for diff, files, browser, terminal and pull request. Servers are merged invisibly into one list. The chrome is neutral zinc with one blue accent, a 10px base radius, small type and hairline borders. This is the visual and interaction base for our mocks (decision D1).

**Status:** read from source and docs in the T3 Code repo at commit `380bba36` (2026-10-13). **Nothing was run.** Everything about how it looks on screen is inferred from classes and tokens. Treat pixel claims as _not verified_ until we open the real app. Paths are in that repo.

## 1. Object model and navigation

| Term              | Meaning                                                                                                                                                                           | Where it shows                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Environment       | One server plus its machine, files and credentials                                                                                                                                | A "Run on" picker, hover cards, Settings → Connections. **Not a navigation level.** |
| Project           | A workspace rooted at a directory. The same repo on several machines groups into one project with several checkouts.                                                              | Icon and name on each thread row; a project scope filter                            |
| Thread            | The durable conversation for a project. It can exist with no project.                                                                                                             | One sidebar row, one page                                                           |
| Turn              | One user-to-agent cycle; owns the checkpoint and diff                                                                                                                             | "Worked for 2m 14s" fold, "N changed files" card                                    |
| Provider instance | One configured copy of a harness                                                                                                                                                  | Model picker, icon on rows                                                          |
| Runtime mode      | Permission policy: Supervised, Auto-accept edits, Auto, Full access                                                                                                               | Select in the composer footer                                                       |
| Interaction mode  | Build or Plan, separate from permissions                                                                                                                                          | Toggle in the composer footer                                                       |
| Scheduled task    | An interval (at least 60 s), a fixed time with optional weekdays, or a webhook trigger that starts a run. No cron expressions (`packages/contracts/src/scheduledTask.ts:26-157`). | Settings → Scheduled tasks                                                          |

What the user sees: **Environment (hidden, merged) › Project (filter and icon) › Thread › Turn.** The sidebar is **not a project tree**. It is a flat list of threads in lifecycle sections.

### The sidebar

16rem wide by default (13rem minimum), resizable. Main content has a 40rem minimum.

```text
+--------------------------------+
| [T3 Code]                  [<] |  title row, 52px
| (S) Search   [filter][+folder][new]
| (draft rows, if any)           |
| PINNED                         |
| +----------------------------+ |
| | [icon] project       Input | |  card row, 78px
| | Thread title               | |   line 1: project, status or time
| | [wt] branch  PR#12 +34 -2  | |   line 3: branch, PR badge, diff counts (mono)
| +----------------------------+ |
| ACTIVE (cards, drag to sort)   |
| ---- shelves sit at the bottom |
| > Working (3)   (beta shelf)   |
| > Snoozed (2)   slim rows      |
| > Settled (14)  slim, dimmed   |
| [undo notice, 5s]              |
| Settings  Usage  Pull requests |
+--------------------------------+
```

| Section        | Row          | Notes                                                                                                     |
| -------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Pinned         | card         | Drag to pin                                                                                               |
| Active         | card         | New threads on top. **Activity does not reorder.** Order is saved on the server and syncs across devices. |
| Working (beta) | card         | Folds running threads into a shelf; Active is then ordered by "last came back to you"                     |
| Snoozed        | slim         | Shows when it comes **back**; a "Woke" label until dismissed                                              |
| Settled        | slim, dimmed | Sorted by settle time, paged                                                                              |

- **Lifecycle:** active → settled (by hand, or automatic after 3 days idle or a merged or closed PR; blocked by pending approvals, questions or live background work), snoozed (a time, or "until usage limit resets"), archived.
- **Hover** reveals Snooze and Settle in the status slot with a cross-fade, so nothing shifts. Press and drag on Settle sweeps several rows.
- **Nearly every action has a 5-second Undo** (also `mod+z`).
- **Search** covers titles and, from 2 characters, your messages and final replies across all connected environments.

### Status vocabulary (default sidebar)

The default sidebar resolves one status per thread, first match wins (`resolveSidebarThreadStatus`, `Sidebar.logic.ts:984-1003`; labels and colours at `Sidebar.tsx:1298-1355`).

| Order | Label                                              | When                                                                             | Colour          |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| 1     | **Approval**                                       | A pending approval                                                               | warning (amber) |
| 2     | **Input**                                          | A pending question                                                               | indigo          |
| 3     | **Working**, or **Goal** while a `/goal` is active | Run preparing, queued, starting, running or waiting. **No shimmer**, on purpose. | info (blue)     |
| 4     | Waiting                                            | Run idle with background work                                                    | muted           |
| 5     | **Limited** (usage limit) or **Failed**            | Last run failed                                                                  | warning; error  |
| 6     | **Woke**                                           | A snoozed thread came back                                                       | warning         |
| 7     | **Done**                                           | Finished and unseen                                                              | success (green) |
| none  | relative time ("3m")                               | Finished and seen                                                                | secondary       |

**There is no "Plan Ready" status and no numeric priority in the default sidebar.** Those belong to the legacy per-project tree (`LegacySidebar.tsx`, `Sidebar.logic.ts:626-1274`), which is off by default (`legacySidebarEnabled`, `packages/contracts/src/settings.ts:468`). The legacy tree ranks approval 5 › input 4 › working 3 › waiting 2.5 › plan ready 2 › done 1, uses a sky pulse for working and violet for plan ready, and rolls status up to the project.

**Recede rule** (`shouldRecedeSidebarThread`, `Sidebar.logic.ts:963-975`): working and waiting rows drop to **70% opacity**. Approval and done rows that are already seen, and not woke, recede to `/75` text at normal weight. Input, active and selected rows never recede. This is T3's nearest thing to a "what needs me" view. It is visual emphasis inside one list, not a separate page.

## 2. The thread view

```text
+----------+-----------------------------------------------+-----------------------+
| sidebar  | header 52px: project > thread title            |                       |
|          |   [actions] [open in editor] [git] [panels]   |                       |
|          +-----------------------------------------------+ right panel (tabs)    |
|          |  content, max 46rem, centred                  | Diff | Files | Browser|
|          |        [user bubble, right, max 80%]          | Terminal | PR | Device|
|          |  assistant markdown (no bubble, left)         | (popover sheet at     |
|          |  > Ran 3 commands, edited 2 files             |  980px or narrower)   |
|          |  [Plan card]  [HTML visual reply]             |                       |
|          |  [ 2 changed files  +34 -2     Open diff ]    |                       |
|          |  Worked for 2m 14s                            |                       |
|          |  [queued messages]                            |                       |
|          |  [banner stack: approval / question / plan]   |                       |
|          |  [ glass composer, rounded-3xl            ]   |                       |
|          |  [ context strip: branch | worktree | host ] |                       |
+----------+-----------------------------------------------+-----------------------+
 terminal drawer (bottom, 180px min), toggled with mod+j
```

Chat width: comfortable 46rem (default), wide 72rem, or full. A thin **minimap** strip on the right edge has a dot per user message.

### Row kinds (`chat/MessagesTimeline.logic.ts:515-650`)

| Row                | Look                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| User message       | Right-aligned bubble, `max-w-[80%] rounded-2xl`. Timestamp, "Edit from here", copy appear on hover. A banner marks "Sent by another agent".        |
| Assistant message  | **No bubble.** Markdown at 14px, `text-foreground/80`. Code with syntax colour, diagrams, copy button, citations.                                  |
| Live work line     | One line while working: icon and latest tool label, with a stepped shimmer. Click to expand.                                                       |
| Tool group         | Collapsed to "Ran 2 commands, edited 3 files". Expands to per-call rows with command, status, exit code. **Raw output is deliberately not shown.** |
| Turn fold          | A centred "Worked for 2m 14s" divider that collapses everything the turn did                                                                       |
| Context compaction | A system divider                                                                                                                                   |
| Event              | Thread created, fork, subagent cards, failures (a small red pill)                                                                                  |
| Plan card          | `rounded-3xl`, collapsed with a fade and "Expand"                                                                                                  |
| HTML reply         | A sandboxed frame ("visual reply")                                                                                                                 |
| MCP app            | An interactive frame in place of the tool call                                                                                                     |
| Changed-files card | After a turn: "N changed files +add −del", a file tree, **Open diff**                                                                              |

### Approvals and questions: docked to the composer, not in the transcript

- **Approval banner:** a header with the kind ("Command approval", "File change approval", and so on) and a `1/3` counter; the command or path in a mono box (max 5 lines, scrolls); buttons **Decline**, **Approve**, and a menu with **Cancel** and **Always allow this session**.
- **Question banner:** the question, options with labels and descriptions, a free-text answer typed in the composer, an `n/m` counter, a collapse chevron so a tall prompt stops covering the thread, and a dismiss X. Single choice auto-advances after a short timer. Async questions stay answerable after the turn ends.
- **On mobile** these become **cards in the feed**.

### Plan mode

A Build/Plan toggle. In plan mode the agent writes a plan card. When the turn settles, the composer shows a banner (the default sidebar shows it as Done; only the legacy tree has a violet "Plan Ready") with **Refine** and **Implement** (plus "implement in a new thread"). `/goal <done condition>` starts a long-running mode with a progress row above the composer.

### Turn controls

- **Edit from here** rewinds to before a message, with options to keep changes or revert files too (worktree threads).
- **Subagents** show as cards. Opening a child shows a subagent bar instead of a composer, with a link to the parent. Child approvals bubble up to the parent.
- **Lineage** (fork, handoff, merge-back) shows in the title breadcrumb.

## 3. The composer

- **Surface:** `rounded-3xl`, glass (`blur(12px) saturate(1.14)` at 80% opacity; 16px and 1.08 in dark), a 1px outline, a soft shadow in light only. Banners attach to its top edge. A context strip (branch, worktree, host) tucks under it.
- **Footer, left to right:**

```text
[ rich text prompt, 14px, auto-grow ]
[+ attach] | [provider-icon Model v] | [Effort v] | [Build|Plan] [Supervised v]    [ctx meter] [Send/Stop]
```

| Feature       | Detail                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rich text     | Markdown shown styled while typing; markers stay in the text.                                                                                                    |
| Triggers      | `/` commands and skills, `$` skills, `@` files and other threads, `#` pull requests                                                                              |
| Context chips | Terminal excerpts, diff comments, files, PRs, **threads** (drag from the sidebar), citations from assistant text                                                 |
| Attachments   | Up to 100 files; images 10 MiB; paste or drag; uploads start at once and block send until done                                                                   |
| Model picker  | A popup with a provider rail and a searchable list. **Shift-click several models in a new thread to fan one prompt out to N threads**, each in its own worktree. |
| Host          | "Run on": a machine (with a kind icon) or **Auto balance**                                                                                                       |
| Send button   | **Morphs:** send → stop (running, empty draft) → steer or queue (running, with text). The other action is `mod+Enter`.                                           |
| Queue         | Saved on the server; rows above the composer with drag handle, promote-to-steer, edit and remove                                                                 |
| Other         | Prompt history on ArrowUp; stash a draft with `mod+s`; context-window meter that opens compaction; voice on iPhone                                               |

**New-thread page:** a centred headline "What should we build in ‹project›?" with the project as a dotted-underline picker, the composer beneath, then it docks to the bottom after the first send.

## 4. The right panel

One tab strip, any mix, saved per thread. Kinds: diff, files, one tab per opened file, browser, device simulator, terminal (split), pull request. Panel open and close is instant by default (a 0 to 400 ms slider).

| Panel          | Contents                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diff           | A scope menu: **Changes** (vs base), **Uncommitted**, **Latest turn**, **Turn N**. File tree, split or unified, word wrap, per-file collapse, find, inline review comments that become composer chips. |
| Files          | Project tree and viewer or editor (markdown, CSV, HTML, PDF, audio)                                                                                                                                    |
| Browser        | In-panel browser with an element picker that makes a chip; an "agent browser" with a visible agent cursor                                                                                              |
| Terminal       | Bottom drawer or panel tab, multiple terminals. **A user shell only; agents are not driven through it.**                                                                                               |
| Source control | A header split button: Commit, Commit and push, Push, Create PR; PR tabs                                                                                                                               |
| Thread details | Workspace, version control, linked PRs, automations, lineage                                                                                                                                           |

## 5. Visual language

### What makes it look clean

1. Almost no colour: neutrals plus one blue. Semantic hues appear only as small status text or dots.
2. Hairline borders instead of cards with shadows. Fills only for hover and selected.
3. Hierarchy through opacity: body `/80`, meta secondary, tertiary `/40`.
4. Small type for metadata (12, 11, 10px) with tabular numbers.
5. One radius family. Pill and 3xl are for the composer and chips.
6. **Glass only on floating layers:** composer, menus, dialogs.
7. Calm motion: panels snap; no continuously repainting animation; pulses are stepped; press is `scale(0.97)`.
8. A faint 3.5% noise grain on the background (_not verified visually_).

### Colour (`apps/web/src/index.css:1086-1190`; `packages/shared/src/themePalettes.ts:137-264`)

| Role                         | Light     | Dark      |
| ---------------------------- | --------- | --------- |
| Canvas                       | `#fcfcfc` | `#0a0a0a` |
| Sidebar                      | `#fafafa` | `#000000` |
| Surface, card, popover       | `#ffffff` | `#111111` |
| Text                         | `#27272a` | `#f5f5f5` |
| Text muted                   | `#71717b` | `#818181` |
| Border                       | `#e4e4e7` | `#191919` |
| Hover, message bubble        | `#f4f4f5` | `#141414` |
| **Primary (the one accent)** | `#1b4ed8` | `#346bf1` |
| Error                        | `#fb2c36` | `#fb414a` |
| Warning                      | `#fe9a00` | `#fe9a00` |

Status hues in the default sidebar: amber (approval), indigo (input), blue `info` (working), green `success` (done). The legacy tree adds sky for working and violet for plan ready.

**Theming:** 61 named colour roles (`themePalettes.ts:47-109`), exported and imported as JSON, VS Code theme import, themes published by the server. Built-ins: stock, T3 Chat (pink), Grove (green), Ocean (blue), Ember (orange), Iris (violet). A contrast slider raises text and border contrast.

### Type

| Item        | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Web UI font | System: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`. **No web font.**                 |
| Mono        | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` (`index.css:168-169`) |
| Root size   | 16px (user range 12 to 20); everything is rem                                                                    |
| Prompt      | 14px; at least 16px on touch to stop iOS zoom                                                                    |
| Code        | 13px; terminal 12px                                                                                              |
| Small scale | 11px, 10px, 8px, 7px                                                                                             |
| Mobile font | **DM Sans** 400, 500, 700                                                                                        |

### Shape, density, sizes

| Token               | Value                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base radius         | 10px (small 6, medium 8, large 10, xl 14, 2xl 18, 3xl 22)                                                                                                                       |
| Control radius      | 8px                                                                                                                                                                             |
| Message bubble      | `rounded-2xl`                                                                                                                                                                   |
| Composer, plan card | `rounded-3xl`                                                                                                                                                                   |
| Dialogs, palette    | `rounded-2xl`, glass, large soft shadow                                                                                                                                         |
| Buttons             | xs 24px, sm 28px, default 32px, lg 36px from the `sm` breakpoint up; 4px taller below it (`components/ui/button.tsx:21-39`); touch hit area at least 44px; disabled 64% opacity |
| Sidebar             | 16rem; row card 78px                                                                                                                                                            |
| Top bar             | 52px                                                                                                                                                                            |
| Scrollbar           | 6px                                                                                                                                                                             |
| Glass               | blur 12px (16px dark), opacity 80%, saturation 1.14 (1.08 dark)                                                                                                                 |
| Motion              | `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`; dialogs 200 ms with scale 0.98                                                                                                 |

## 6. Mobile

- **No sidebar on a phone.** Home is a full-screen thread list; a thread is a pushed screen with a native back. iPad keeps a split view. iOS uses a glass header; Android uses Material 3 with a FAB.
- **Swipe actions** replace hover actions. Drag to reorder becomes an "Arrange threads" sheet.
- **Composer:** a floating glass pill with radius 26 to 27, 44px controls, collapsed to one line until tapped. The send button shows Queue or Steer; long-press does the other. Offline queueing. Voice input.
- **Approvals and questions are feed cards** (`rounded-[20px]`).
- **Panels become screens or sheets:** terminal, browser, device, files, git, review.
- **Notifications:** push for finish, fail, approval and question; Live Activities on iOS and ongoing cards on Android for running agents.
- **Scheduled tasks are editable on the phone.**
- Mobile tokens: light screen `#fcfcfc`, card `#ffffff`, user bubble `#efeff1`, primary `#1b4ed8`; dark screen `#0a0a0a`, card `#111111`, user bubble `#161616`, primary `#346bf1`.
- Connection pills: Connected (emerald), Reconnecting (warning), Connecting (blue), Offline (danger), Available (subtle).

## 7. Multi-machine and remote UX

- The client holds a list of environments. Threads and projects from all of them merge into one sidebar. Machine identity shows as a **kind icon** (server, cloud, linux, desktop, laptop, mini PC, workstation) in the "Run on" picker, hover cards and Connections.
- **Settings → Connections** row: machine icon, name, a one-line subtitle ("This machine", "SSH user@host", or "via ‹route›"), controls, expandable route list. Offline rows dim to 60%.
- **Routes per machine:** LAN, Tailscale, VPN, public URL, SSH, tunnel. Ordered by speed, **drag to reorder**. The first answering route wins and earlier ones are re-checked when the network changes and every minute.
- **Load balancing** per machine: Normal, Prefer, Less often, Manual only.
- **Settings inheritance chain:** each setting row shows a layers icon with default › environment › project override. It turns amber and says "Mixed" when environments disagree.
- **Onboarding:** "Connect your computers", then "Check your agents" (install and sign-in per machine), then import projects grouped by computer.
- Pairing is by link or QR.

## 8. Command palette and keyboard

`mod+k` opens a palette (`max-w-xl`, virtualised, results grouped). Groups: Actions, Recent Threads; typing adds Projects, Settings (every setting is searchable) and Threads (message search). `>` shows only actions. Items show their shortcut. Every action is reachable from the palette, a menu **and** a shortcut.

| Area       | Keys                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation | `mod+k` palette, `mod+b` sidebar, `mod+[` `mod+]` back and forward, `mod+shift+[` `]` previous and next thread, `mod+1..9` jump to thread |
| New thread | `mod+n`, `mod+shift+n` (local), `mod+alt+n` (no project)                                                                                  |
| Thread     | `mod+shift+s` settle, `mod+shift+p` pin, `mod+z` undo, `mod+f` find                                                                       |
| Panels     | `mod+d` diff, `mod+j` terminal, `mod+shift+j` preview, `mod+t` new tab, `mod+w` close, `mod+shift+t` reopen                               |
| Composer   | `mod+shift+m` model, `+e` effort, `+a` access mode, `+h` host, `+x` workspace, `mod+s` stash                                              |

All rebindable in a JSON file with `when` contexts (`terminalFocus`, `composerFocus`, `turnRunning`, `isWeb`, `isDesktop`, and others).

## 9. Other features worth knowing

- **Usage page:** tokens and cost by model, provider and speed; subscription limits; a limits widget in the composer.
- **Project actions** (`t3.json`): named scripts with icons that run on worktree creation or settle.
- **Visual replies and MCP apps:** an agent can publish a sandboxed HTML page or an interactive app into the thread, themed to match the app.
- **Portable handoffs, fork, merge-back, prompt links.**

## 10. Gaps for a fleet-and-brain app

T3 is a very good single-user "many threads, many machines, one inbox" client. It has no shared brain, no profiles, no first-class agent-to-agent view and no fleet dashboard.

| Requirement                                         | T3 coverage                                                                                                                                                                                                                                                               | What to extend                                                                                                                                                     | Verdict                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fleet view** (machines up, load, what runs where) | **Partial.** Connections lists machines with route state, version and load-balance setting. Resource telemetry shows CPU and memory per environment. No overview page and no per-machine thread counts.                                                                   | The Connections row, resource telemetry, load-balancing settings.                                                                                                  | Promote to a top-level **Fleet** page. Per-machine counts are derivable client-side from `environmentId`.                                                                                                                                                                    |
| **KB and memory**                                   | **None.**                                                                                                                                                                                                                                                                 | `@`-mention of threads as chips; `t3_thread_read/list` MCP tools; the Files viewer; the palette's search groups.                                                   | Build a Brain page and a `kb-page` context-chip kind using the existing `t3-context://v1/<kind>/<id>` contract.                                                                                                                                                              |
| **Scheduler**                                       | **Largest partial.** Three triggers (fixed time with weekdays, interval of at least 1 min, webhook with HMAC and templating); bound to project, model and workspace; run on a chosen machine; run now; pause; delivery log; mobile editor; manageable by agents over MCP. | `ScheduledTasksSettings.tsx`, `scheduledTask.ts`, the thread automations panel.                                                                                    | Extend. Missing: run history per task (only the last status), a cross-machine calendar or timeline, a failure inbox, profile or KB targets. It is buried in Settings today.                                                                                                  |
| **Project docs in the KB**                          | **None.**                                                                                                                                                                                                                                                                 | The project page route, the file viewer and markdown renderer, the plan card's "save to workspace".                                                                | Build a project **Docs** tab that renders KB pages.                                                                                                                                                                                                                          |
| **Profiles**                                        | **Weak partial.** Provider instances (accounts, home dirs, accent colour, per-project enable). No named persona with instructions, memory and tool allowlist.                                                                                                             | `ProviderInstanceCard`, accent colour picker, the **settings inheritance-chain widget** (default › environment › project), which fits profile › project overrides. | Model a profile as an instance plus a system prompt, KB scope and permission mode, shown as an avatar or accent beside the model pill and on rows.                                                                                                                           |
| **Group chat between agents**                       | **Plumbing only.** Agents message each other's threads over MCP; a "Sent by another agent" marker; parent and child breadcrumbs. No shared room, participant list, @-addressing or unified transcript.                                                                    | The orchestrator MCP tools, thread lineage, the user-bubble and assistant layout.                                                                                  | Build a **room** thread type that interleaves several agents' messages, with an avatar and name per participant. _Not verified:_ whether the server has a cross-thread event stream suited to a live room.                                                                   |
| **Apps and plugins**                                | **Partial.** MCP apps and HTML replies render in the thread. No launcher, no pinned surface outside a thread.                                                                                                                                                             | The MCP app frame, the HTML frame, the right panel's tab model (any `kind`).                                                                                       | Show apps as right-panel tabs and a sidebar **Apps** shelf.                                                                                                                                                                                                                  |
| **"What needs me" view**                            | **Partial and implicit.** A ranked status, the recede rule, a project roll-up, push and Live Activities, snooze and auto-settle. **No inbox page**, no cross-machine count badge, no sort by urgency.                                                                     | The status priority table, `shouldRecedeSidebarThread`, the snooze and wake machinery.                                                                             | Easiest win: a **Needs me** section driven by the same priority map, grouped by machine or profile, with approve and answer **inline**. Approval and question components are bound to the composer today and need extracting into standalone cards (mobile already has one). |
| **Fleet-scale permissions**                         | **Partial.** Per-environment and per-client scopes, runtime mode per thread, project and environment, "Mixed" display.                                                                                                                                                    | Authorised clients list, pairing scopes.                                                                                                                           | Reuse as is.                                                                                                                                                                                                                                                                 |
| **Secrets**                                         | A secret-request card; values never enter the model transcript.                                                                                                                                                                                                           | The request-secret flow.                                                                                                                                           | Matches "secrets pass by name". Reuse.                                                                                                                                                                                                                                       |

**Revised by the fork plan (doc 11):** two verdicts above changed. Rooms are **our own page** over ordinary per-agent "seat" threads, not a new thread type, because T3's thread model is single-agent. Apps open on **our own routes**, not as new right-panel tab kinds, because a tab kind touches six upstream files including `ChatView.tsx`.

### Cross-cutting notes for the mocks

- **Strongest transferable ideas:** the flat lifecycle-sectioned list with statuses and hover actions; approvals and questions docked to the composer; the turn fold and changed-files card; one tabbed right panel; the inheritance-chain widget; machine routes with automatic failover; Undo for everything; keyboard command ids with `when` contexts.
- **T3 hides the environment as a navigation level on purpose.** A fleet app needs the machine as a first-class facet: filter chips, group by machine, per-machine health.
- **The Collie-based Fuse's rules still help** (doc 03): status as a shape plus colour, and no state moving the layout. T3 already follows the second one on hover actions.

## Key files in the T3 Code repo

| Topic                       | File                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens, glass, motion, type | `apps/web/src/index.css`                                                                                                                                              |
| Palettes                    | `packages/shared/src/themePalettes.ts`                                                                                                                                |
| Sidebar                     | `apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`                                                                                                             |
| Timeline                    | `apps/web/src/components/chat/MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`                                                                                      |
| Composer and banners        | `apps/web/src/components/chat/ChatComposer.tsx`, `ComposerSurface.tsx`, `ComposerBanner.tsx`, `ComposerPendingApprovalPanel.tsx`, `ComposerPendingUserInputPanel.tsx` |
| Right panel                 | `apps/web/src/rightPanelStore.ts`, `components/RightPanelTabs.tsx`, `DiffPanel.tsx`                                                                                   |
| Palette and keys            | `apps/web/src/components/CommandPalette*.tsx`, `packages/shared/src/keybindings.ts`                                                                                   |
| Connections                 | `apps/web/src/components/settings/ConnectionsSettings.tsx`, `EnvironmentRow.tsx`                                                                                      |
| Scheduled tasks             | `apps/web/src/components/settings/ScheduledTasksSettings.tsx`, `packages/contracts/src/scheduledTask.ts`                                                              |
| Mobile                      | `apps/mobile/src/Stack.tsx`, `features/home`, `features/threads`, `features/connection`                                                                               |
