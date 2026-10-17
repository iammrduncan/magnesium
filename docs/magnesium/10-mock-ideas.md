# Ideas for the UI mocks

**Status: mocked (2026-10-13).** These ideas became the mock canvas, and the owner approved the direction (D9). The canvas has 16 clickable boards, with example data only. What it takes to build them is in [doc 13](13-mocks-to-working-app.md). Nothing in this file is built. Each idea says which requirement it serves and which T3 Code feature it builds on.

**Base:** T3 Code's look and layout (doc 07). No terminal in the main flow (D3). The app is **Magnesium**, the T3 Code fork (D8); the older Collie-based Fuse is a reference only (doc 03). Mocks: the "dBrain Harness Mocks" canvas (Home, Session, Room, Fleet, phone Home).

## One shell, seven places

T3 Code's shell is: sidebar, one conversation, a tabbed right panel. We keep it and add the places the requirements name.

| Place                        | Requirement | Starts from in T3 Code                           | What is new                                                                                                     |
| ---------------------------- | ----------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Home / Glance**            | P1          | The sidebar's status ranking and "recede" rule   | A page, not only a list: **Needs me** first, then priority, running work, next scheduled runs, fleet health     |
| **Sessions** (one-off chats) | M3, M3a     | The thread view and composer                     | A **profile** picker beside the model pill; KB-backed context                                                   |
| **Projects**                 | M2          | Project filter and project page                  | A **Docs** tab that shows the project's KB space; sessions grouped under it                                     |
| **Bots** (channels and DMs)  | M1, A5, A6  | Orchestrator MCP, "sent by another agent" marker | A **room page** with several agents' messages interleaved, over one seat thread per agent (doc 11)              |
| **Fleet**                    | M4, F2      | Connections list, resource telemetry             | A top-level page: machines, what runs on each, jobs, autoresearch runs                                          |
| **Apps**                     | M5          | MCP apps and HTML replies                        | A pinned **Apps** shelf; apps open on our own route (a new right-panel tab kind is too costly to carry, doc 11) |
| **Scheduler**                | M6          | Scheduled tasks (three trigger types)            | A first-class page with run history, a timeline and a failure inbox                                             |

The **KB** has its own surface too (K1 to K7): search, pages, the ingest pipeline and the nightly dream cycle. It can be a top-level place or a right-panel tab. Open question.

## Ideas worth mocking first

### 1. The Glance home (P1)

- **Needs me** at the top: approvals, questions, plan-ready, failures, blocked machines. Approve or answer **inline** on the card, so there is no need to open a thread.
- Then **priority**, **running**, **next scheduled runs**, **fleet health**, **KB activity**.
- Status uses a **shape plus colour** (doc 03) on top of T3's default colours: amber approval, indigo input, blue working, green done, red failed. **Plan ready is ours to add**: T3's default sidebar shows a finished plan as Done.
- Ranking (D18): start simple, kind first, then oldest wait, with a pin to override; adjust with use.

### 2. The zoom control (P2)

One control that changes how much of a thing you see:

| Level          | You see                                                  |
| -------------- | -------------------------------------------------------- |
| **Glance**     | Counts and the one line that needs you                   |
| **Card**       | Title, profile, machine, status, last action             |
| **Transcript** | The T3-style conversation with folds                     |
| **Detail**     | Tool output, diffs, raw events (never a terminal mirror) |

It would apply to the Home page, the Fleet page and a thread, so "as high or low level as I want" has one habit.

### 3. Profile as a first-class thing

- A profile has an avatar and accent colour, shown next to the model pill and on each row.
- Its page shows identity, memory notes, skills, schedule and sandbox level.
- Use T3's **inheritance-chain widget** for profile › project overrides.
- Serves A4. Needs API reads that exist (`get_agent`, `read_memory`) and writes that do not.

### 4. Rooms for group chat (A6)

- A page with several participants. Each message carries an avatar and name.
- The rules from an earlier interface plan still fit: an @mention routes a message, otherwise the lead bot answers; at most three bot-to-bot turns before it returns to the owner; nothing is hidden between bots.
- Under each message, a **"routed to"** chip says who was woken and why (`@mention`, `reply`, `lead`, `model 0.82`). Design in doc 12; the room is our own aggregate with one seat thread per agent (doc 11).

### 5. Fleet page

- A grid or list of machines with kind icons (T3 already has them), state, load, and the sessions and jobs on each.
- A **group by machine** facet and a filter chip row on Home.
- GPU and autoresearch runs appear as jobs with a progress line.

### 6. Scheduler page

- A list with the next run, last status and an on/off switch (T3's row layout), plus a **timeline** across machines, a **run history** per task and a **failure inbox**.
- Create and edit as a sheet. Targets can be a profile, a project or a KB document.

### 7. Project mode

- A project is a folder with sessions, dropped docs and a KB space at `/projects/<name>`.
- Dropping a doc on a project saves it to the KB and shows it in the **Docs** tab.

### 8. Phone and desktop pill

- The phone follows T3's mobile app: no sidebar, a full-screen list, swipe actions, approvals as feed cards, Live Activity for running agents. The phone runs the same web UI as an installed PWA (D10). Live Activities are not available to a PWA; web push covers needs-you alerts.
- The desktop pill (I3) shows the count of waiting items, the top item, and quick actions: approve, reply, open.

## Constraints to keep while mocking

- **Snappy by design.** Show a summary row, load detail on demand (doc 06). Mocks should show collapsed tool groups and a "load earlier" affordance, not full logs.
- **No layout shift** when a status changes (T3's hover actions and the Collie-based Fuse's rule agree).
- **Supervised by default** for anything that can act.
- **Machine as a visible facet.** T3 hides it; a fleet app cannot.
- **Secrets by name only.** Reuse T3's secret-request card pattern.

## Next steps

1. **Mocked:** Home, Session, Room, Brain (overview and document), Fleet, Apps, Selected app, the footer, and five phone screens.
2. **Project mode** is mocked for review (D23): a project's threads and docs, linked together in the brain.
3. Not mocked yet: **Schedule** (run history, timeline, failure inbox), a **Profile** page and the **desktop pill** (I3).
4. Run spikes S1 to S5 (doc 11) before build work starts. Then build phase by phase. Each phase is done when its boards work with real data (doc 13).
