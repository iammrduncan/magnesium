# Magnesium build goals

**The order goals are built in, and where each stands, is in [TRACKER.md](../../../TRACKER.md).** Thirty-four goals take Magnesium from a fork of T3 Code to the app in the mocks. At the end it runs on a hub and a fleet of agent machines, on bare metal, in VMs or inside Kubernetes workloads. Each goal ends in something the owner can test by hand.

Read first: [doc 11](../11-fork-plan.md) (the fork plan), [doc 13](../13-mocks-to-working-app.md) (mocks to a working app), [doc 09](../09-decisions-and-open-questions.md) (the decisions), [doc 12](../12-channel-chat-and-events.md) (rooms) and [doc 14](../14-apps-and-footer-extension-model.md) (apps and the footer).

## Test fleet

Goals are tested by hand on a real fleet: a hub and at least two machines, one of them with a GPU and one running in Kubernetes, plus a desktop and a phone with the installed PWA. Goals name them by role ("the hub", "a machine", "a machine with a GPU"), never by host.

## Goals and what they need

The build order and each goal's status are in [TRACKER.md](../../../TRACKER.md). This table says what each goal makes testable and what it builds on; the picture below it shows the tracks.

| #   | Goal                                                                         | What you can test at the end                                                                                                              | Needs          | Boards made real                                                        |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| 01  | [Fork and rebrand](_completed/01-fork-and-rebrand.goal)                      | T3 Code runs as Magnesium on your desktop, with telemetry and self-update off                                                             | none           | none                                                                    |
| 02  | [Deploy the hub and machines](_completed/02-deploy-hub-and-machines.goal)    | One URL on desktop and phone reaches every server through the hub                                                                         | 01             | none                                                                    |
| 03  | [Profiles and sandboxes](03-profiles-and-sandboxes.goal)                     | Pick a profile and sandbox for any thread, on any machine                                                                                 | 02             | Session · desktop (picker)                                              |
| 04  | [Hub link](_completed/04-hub-link.goal)                                      | The hub shows every server live; devices reach machines only through the hub                                                              | 02             | none (a first Fleet list)                                               |
| 05  | [Shell, sidebar and footer](_completed/05-shell-sidebar-and-footer.goal)     | Places, project folders, comfy and compact, the footer; installs as a desktop PWA                                                         | 04             | sidebars of Home and Session, Footer                                    |
| 06  | [Home: needs you](_completed/06-home-needs-you.goal)                         | Every approval, question and plan from every machine on Home, answered there                                                              | 05             | Home · desktop                                                          |
| 07  | [Phone and push](07-phone-and-push.goal)                                     | Installed on the phone; a locked phone gets "1 needs you" and you approve from it                                                         | 06             | Home · phone, Session · phone                                           |
| 08  | [Rooms](08-rooms.goal)                                                       | You and three bots in one room with explicit routing, hop caps and Stop                                                                   | 03, 06         | Room · desktop, Room · phone                                            |
| 09  | [Room routing](09-room-routing.goal)                                         | Clef picks who an unaddressed message is for, shadow first, then live                                                                     | 08             | Room · desktop (decision log)                                           |
| 10  | [Fleet and launch](10-fleet-and-launch.goal)                                 | Live load and GPUs per machine, what runs where, launch anywhere                                                                          | 03, 04         | Fleet · desktop, Fleet · phone, Home's fleet tiles                      |
| 11  | [Schedule](11-schedule.goal)                                                 | Create and edit scheduled runs, with history and a failure inbox                                                                          | 06, 10         | Schedule boards (mocked in this goal)                                   |
| 12  | [Brain reader](12-brain-reader.goal)                                         | Ask the Brain, browse it as a tree, read any page, start a thread about it                                                                | 05             | Brain · desktop, Brain · document open                                  |
| 13  | [Brain memories](13-brain-memories.goal)                                     | Edit a memory, ask its owner to change one, retry the dream cycle                                                                         | 12             | Brain · desktop (memories, dream cycle)                                 |
| 14  | [Profile learning](14-profile-learning.goal)                                 | A profile's sessions turn into its own memory notes and skill proposals                                                                   | 03, 13         | Brain · desktop (skills)                                                |
| 15  | [Projects](15-projects.goal)                                                 | One project across machines; its page shows what needs you and every thread                                                               | 05, 06         | Project · desktop (threads)                                             |
| 16  | [App host](16-app-host.goal)                                                 | GPU Board as an app: page, footer item, popover, and an action that asks first                                                            | 06, 10, 27     | Apps · desktop, Selected app · desktop, App · phone, both Footer boards |
| 17  | [App builder](17-app-builder.goal)                                           | A builder thread on the hub, on any harness, builds and publishes apps and plugins with you, coordinating agents on other machines        | 16, 18, 27, 28 | Apps · desktop (New app)                                                |
| 18  | [Agent control](18-agent-control.goal)                                       | A profile launches and steers a worker on another machine, within your grants                                                             | 03, 10         | Fleet (started-by)                                                      |
| 19  | [More harnesses and sandboxes](19-more-harnesses-and-sandboxes.goal)         | OpenCode, Pi and oh-my-pi profiles; Kubernetes and microVM sandboxes                                                                      | 03, 10         | Session · desktop (picker)                                              |
| 20  | [Desktop pill](20-desktop-pill.goal)                                         | A small desktop pill shows who needs you and approves in one click                                                                        | 06             | Pill board (mocked in this goal)                                        |
| 21  | [Hermes moves](21-hermes-moves.goal)                                         | Bots import from Hermes Agent one at a time, with a trial window; then Hermes can be retired                                              | 07, 09, 13, 18 | Room, Home                                                              |
| 22  | [Release](22-release.goal)                                                   | A day of daily use; upgrade, rollback and restore drills pass                                                                             | all            | every board                                                             |
| 23  | [Project knowledge](23-project-knowledge.goal)                               | Drop a doc on a project; it lands in the Brain, linked to the project's threads                                                           | 12, 15         | Project · desktop (docs and brain panel)                                |
| 24  | [Upstream V2](_completed/24-upstream-v2.goal)                                | Upstream's v0.1.0 on every server; scheduled runs on Home                                                                                 | 06             | none                                                                    |
| 25  | [Spokes in Kubernetes](_completed/25-spokes-on-kubernetes.goal)              | Machine servers run in Kubernetes, attached inside the workloads that do the work, moved in from bare metal with rollback                 | 06             | none                                                                    |
| 26  | [Recaps](26-recaps.goal)                                                     | Turn recaps on and pick their model; a long-running session says what it did, what is open for you and what it is doing now               | 06, 24         | none                                                                    |
| 27  | [Design system](27-design-system.goal)                                       | Apps built only from Magnesium's kit look native and follow your theme; agents build with it                                              | 05, 06         | Home, Apps and Footer (the kit's pieces)                                |
| 28  | [Machine parts](28-machine-parts.goal)                                       | An app with a part on chosen machines: stats for its hub page, tools for sessions there                                                   | 03, 10, 16, 25 | Apps, Selected app, Fleet                                               |
| 29  | [Magnesium Brain](29-magnesium-brain.goal)                                   | Magnesium runs its own Brain: agents reach it only through Magnesium, and an existing knowledge base can be imported once                 | 03, 04         | none                                                                    |
| 30  | [Accounts](30-provider-accounts.goal)                                        | Sign in to your Claude Code and Codex subscriptions once on the hub; every machine gets them, and you swap the active one from the hub    | 03, 24, 25     | none                                                                    |
| 31  | [Add a machine over SSH](31-add-a-machine-over-ssh.goal)                     | Add a machine from the hub with an SSH target: it installs, starts, pairs and gets your accounts, in a pod too                            | 25, 30         | none                                                                    |
| 32  | [Kubernetes clusters from the hub](32-kubernetes-clusters-from-the-hub.goal) | Give the hub a namespace: it deploys the gateway, runs Magnesium's own pods and attaches to a workload you pick                           | 25, 31         | none                                                                    |
| 33  | [Waiting on you](33-waiting-on-you.goal)                                     | A turn that ends asking you something, or waiting on your approval, shows on Home's Needs you, checked by a cheap model                   | 06, 24         | Home · desktop                                                          |
| 34  | [Profiles in the app](34-profiles-in-the-app.goal)                           | Create, edit and delete profiles in the app, with their tools and knowledge access; see which machines hold each; approve agents' changes | 03, 06         | Profiles (drawn in this goal), Session · desktop (picker)               |

```text
01 ─► 02 ─┬─► 03 ──────────────────────────────────────┐
          └─► 04 ─► 05 ─► 06 ─► 25 k8s ─► 24 V2 ─► 34 profiles ─► 33 waiting ─► 15 projects ─► 07
                     │     │                           │
     after 24, beside 15:  26 recaps, 30 accounts      │
                           30 ─► 31 add over SSH ─► 32 clusters
     after 07, in parallel:                            │
       rooms   08 ─► 09                (needs 03)
       fleet   10 ─► 11 schedule       (needs 03)
               10 ─► 18 agent control
               10 ─► 19 harnesses and sandboxes
       apps    27 design ─► 16 apps ─► 28 machine parts ─► 17 builder
                            (16 and 28 need 10; 17 needs 18)
       brain   29 Magnesium Brain ─► 12 ─► 13 ─► 14 learning
                                     12 ─► 23 project knowledge (needs 15)
       pill    20
     then      21 Hermes moves (07, 09, 13, 18) ─► 22 release
```

Goals in different tracks can run at the same time; see [Running goals in parallel](#running-goals-in-parallel).

## Running goals in parallel

One session, the coordinator, runs the goals. It is the session the owner talks to. Each goal is built by a background subagent in its own git worktree (`isolation: "worktree"`), on a branch named `goal/<nn>-<slug>`.

**The coordinator owns everything shared or outward-facing.** Subagents ask it instead of doing these themselves.

- **Owner gates and questions.** A subagent that reaches a gate stops and reports. The coordinator asks the owner, then resumes the subagent with the answer.
- **Merging.** The coordinator rebases a goal's branch onto `main`, runs the tests that branch touched, and pushes. Subagents never push. The full typecheck and test suite runs on `main` (CI) once per goal.
- **Rollouts.** One rollout at a time, from a `main` commit that includes every goal merged so far. The hub is redeployed only with the owner's approval.
- **The browser.** One integrated pass per goal, after asking the owner once. Subagents start no dev web servers and no browsers. A headless scratch server (`serve` with a scratch home, on its own port, stopped by its PID) is fine for their tests.
- **The report.** The final reply has every goal's dated summary and next steps.

**Each subagent:**

- installs dependencies in its worktree first, then builds and tests its goal there;
- commits small, on its own branch;
- reports to the coordinator when a piece is ready to merge or deploy, at each owner gate, and when it is blocked;
- writes its goal file's summary and next steps.

**Shared files.** These change in most goals: `magnesium/server/src/index.ts`, `magnesium/contracts/src/index.ts`, `apps/server/src/magnesiumRoutes.ts` and `pnpm-lock.yaml`. Keep edits to them to a line or two. The coordinator merges them, and regenerates the lockfile instead of hand-merging it. When two goals need the same new piece, the goal that owns it builds it, and the other builds on it after it merges.

## Requirements covered

Requirement IDs are from [doc 01](../01-requirements.md).

| Requirement                                                          | Goals                                             |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| I1 web app in T3 Code's style                                        | 01, 05, and every later goal                      |
| I2 phone app with the same features                                  | 07, plus the phone board in 08, 10 and 16         |
| I3 desktop pill                                                      | 20                                                |
| P1 at a glance; P2 high or low level                                 | 06 (feed, zoom), 22                               |
| M1 bot mode; A6 group chat                                           | 08, 09                                            |
| M2 project mode; K5 project knowledge                                | 15, 23                                            |
| M3 session mode; M3a profile and harness per session                 | 03, 19                                            |
| M4 fleet mode; F2 monitor machines and agents                        | 04, 10, 17 (autoresearch)                         |
| M5 app mode; custom mini apps                                        | 16, 17                                            |
| M6 scheduler mode                                                    | 11                                                |
| A1 any harness                                                       | 03, 19                                            |
| A4 profiles build memory; A7 reflection; K7 learning from sessions   | 14                                                |
| A5 profile to profile; F3 agents steer sessions; L2 workers anywhere | 18                                                |
| F1 launch anywhere, context staged                                   | 03, 10, 19                                        |
| K3 dreaming; K6 memory and facts                                     | 13                                                |
| K4 ingestion                                                         | 23 (the entry point; the pipeline is GBrain work) |
| L1 main bots on the hub                                              | 02, 21                                            |

## Goal file format

Front matter (`id`, `kind`, `depends_on`, `phase`, `boards`), then **Owner gates**, **Build**, **Test it**, **Not in this goal**, **Goal summary** and **Next steps**. `phase` is the phase in docs 11 and 13. A goal's status lives only in [TRACKER.md](../../../TRACKER.md): `Planned`, then `In progress`, then `Verified`, or `Blocked` with the reason. A `Verified` goal moves to `_completed/`.

## Done means, for every goal

1. **The owner's test passes on the real machines.** The agent runs every "Test it" step on the hub and the machines the goal names, and records what it saw: date, build, and screenshots for UI. A fixture or a local run is not the test.
2. **It matches its boards.** Each screen is compared with its mock board in light and dark, and in comfy and compact where the board has both. Differences are listed in the summary for the owner to accept or reject.
3. **Automated tests pass:** the fork's typecheck and tests, and our packages' tests. Each behaviour change gets a test.
4. **Merge cost is recorded:** the list of edits to upstream files (every `magnesium:` marker) and the per-file conflict report from a merge rehearsal against upstream's latest stable tag.
5. **Deployed and reversible.** The change is rolled out with the Ansible roles from goal 02, and the previous build can be restored with one command.
6. **Docs are updated.** The matching research doc says what is built and verified. [Doc 13](../13-mocks-to-working-app.md) gets a status for each screen.
7. **Goal summary and next steps** are written into the goal file and included in the final report, even when the goal is blocked, and its row in [TRACKER.md](../../../TRACKER.md) says where it stands.

## Rules for every goal

- **Magnesium builds its own tools (D37).** Profiles and their checks, the agents API (each operation written once for the `magnesium-agents` CLI, REST and MCP), schedules and deployment are built in the `magnesium/*` packages. An earlier toolkit is reference only: nothing goes into it, and Magnesium never depends on it at runtime.
- **Owner gates: stop and ask** before:
  - any change to who can reach the hub or the machines;
  - anything that loosens the hub's isolation;
  - importing each bot from Hermes, and retiring Hermes (goal 21);
  - publishing anything outside the owner's own setup.
- **Supervised by default.** New threads start in supervised mode, and full access is never a default. Scheduled and headless runs are never weaker than the `container` sandbox.
- **Secrets by name only.** They never go in settings, profiles, app manifests, argv or logs.
- **Magnesium starts no GPU work of its own.** It reads GPU metrics. Agents attached inside a GPU workload (D59) may use that workload's GPUs.
- **Only sessions started from Magnesium are shown** (D25).
- **Fork discipline (D11).**
  - New code goes in the `magnesium/*` packages.
  - Every edit to an upstream file is marked with a `magnesium:` comment.
  - The strip-and-rename commit is a script, re-run on every merge.
- **Streams follow doc 06:**
  - a bounded snapshot with a sequence number;
  - subscribe after a sequence;
  - paged history;
  - about 50 ms of coalescing;
  - byte-budget tests.
- **Test data looks like real use.** Give test projects distinct names that say what they hold, and include a project that spans machines (D50). Never make one same-named scratch project per machine: the screens are judged on telling things apart.
- **Example data never ships.** Empty, loading, offline and error states are real states. The mocks' sample data stays in the mocks.
- **A place stays hidden until its goal lands.** The sidebar shows only places that work.
- **What a goal adds to the UI goes where the boards put it,** even when the board's own goal comes later: a sidebar place sits in the places list, a footer item in the footer. A goal with no board still checks every screen and control it adds against the boards that show it, and lists any difference for the owner.
- **Product only, in public.** Goal files, docs and commit messages describe the product: what it does and how anyone installs, configures and tests it. Nothing about the owner's own setup goes in: no hosts, machine names tied to hardware, network paths, open ports, deployment logs or gaps. Notes about the owner's setup go in the gitignored `.internal/` folder; tokens stay in the secret store.

## Not covered here

These are GBrain-side work, in the knowledge base behind the Magnesium Brain and its jobs, outside these goals. Magnesium shows them and can trigger them:

- the dream cycle's rollout on a live GBrain (K3);
- the full link-to-research-to-relevance pipeline (K4);
- the sync modules (K2).
