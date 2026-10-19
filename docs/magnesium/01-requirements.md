# Requirements, numbered

This restates [`requirements.txt`](requirements.txt), the owner's requirements, with IDs, and says where Magnesium stands on each line and which [goal](goals/README.md) covers it, as of 2026-10-18.

**Status words:** _built_ (code, tested in its goal), _partly built_, _designed_ (a doc, no code), _planned_ (a goal covers it, nothing built yet).

## The five parts of the harness

1. KB / brain / memories
2. Agent loops
3. Persistent profiles, context and self-learning
4. Infrastructure and fleet management
5. Custom mini apps: plugin-style, serving dashboards and new features

## KB

| ID  | Requirement                                                                                                                                                           | Status in Magnesium                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | Persistent, organised wiki KB with vector and hybrid search                                                                                                           | **Planned.** Magnesium runs its own Brain on a GBrain engine (goal 29); goal 12 reads and searches it.                                                                  |
| K2  | Many sync modules that collect data into the KB                                                                                                                       | **Planned.** [Goal 36](goals/36-brain-sources.goal) adds, syncs, pauses and fixes the Brain's sources, and moves the old knowledge base's collectors into them.         |
| K3  | Nightly "dreaming": memory creation and curation                                                                                                                      | **Planned.** Goal 13 shows the dream cycle and retries it. Its rollout is knowledge-base work.                                                                          |
| K4  | Ingestion pipelines: a link, a Hugging Face page, a PDF and so on → research → raw data, raw research, synthesised answer, "why it matters to me" by area and project | **Planned.** Goal 23 is the entry point: drop a doc on a project. [Goal 36](goals/36-brain-sources.goal) researches what arrives into a synthesis and "why it matters". |
| K5  | Project-based knowledge and organisation                                                                                                                              | **Planned** (goals 15 and 23).                                                                                                                                          |
| K6  | Individual and team memory and facts                                                                                                                                  | **Planned** (goal 13): edit a memory, or ask its owner to change it.                                                                                                    |
| K7  | Auto-learning from sessions                                                                                                                                           | **Planned** (goal 14).                                                                                                                                                  |

## The agent interface (the UI)

| ID  | Requirement                                                                                                        | Status in Magnesium                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Bot mode:** channels and DMs with long-running sessions                                                          | **Designed** (doc 12). Rooms are goal 08, routing goal 09.                                                                                                                                  |
| M2  | **Project mode:** folders with their own sessions; extra docs dropped in and saved to `/projects/<name>` in the KB | **Partly built.** Project folders in the sidebar, across machines (goal 05). The project page is goal 15, its docs in the Brain goal 23.                                                    |
| M3  | **Session mode:** one-off chats backed by general memory and the KB                                                | **Partly built.** One-off threads are stock T3 Code, each with a profile (goal 03). Backing by the Brain comes with goal 29.                                                                |
| M3a | In project and session mode, pick the profile and harness per session, with a default                              | **Built** (goal 03, blocked only on a Brain check): a profile and sandbox picker per thread, and a default per project.                                                                     |
| M4  | **Fleet mode:** every active session and job across the cluster                                                    | **Partly built.** A first Fleet list shows every server live, with its running and waiting threads (goal 04). Jobs, load and launch are goal 10.                                            |
| M5  | **App mode:** list of apps, pin the ones that matter                                                               | **Planned** (goals 16 and 17).                                                                                                                                                              |
| M6  | **Scheduler mode:** view, create and change scheduled jobs and agent runs                                          | **Partly built.** Upstream's scheduled tasks run, and Home shows the next runs and the failed ones (goal 24, in progress). The Schedule page, with history and a failure inbox, is goal 11. |

## The agents

| ID  | Requirement                                                                | Status in Magnesium                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Works with any harness (Claude Code, Codex, OpenCode, Pi, oh-my-pi, …)     | **Partly built.** Magnesium keeps T3 Code's drivers: Claude, Codex, Cursor, Grok, OpenCode, Pi, Muse, Antigravity and any ACP agent (doc 08). Profiles run Claude and Codex (goal 03). OpenCode, Pi and oh-my-pi profiles are goal 19; T3 has **no driver for omp** (O12). |
| A2  | Uses the native harness. **Not** `claude -p`, **not** the Agent SDK        | **Relaxed by the owner (D6, doc 09).** It clashed with "no TUI in the UI" (D3). T3 Code drives Claude through the Agent SDK, which spawns the native `claude` binary with its own login, prompt and tools. The owner will try that path.                                   |
| A3  | Uses each harness's built-in tooling, which the models are trained on      | **Built** by design (goal 03): a profile is a provider instance whose home is the harness's own config folder, so each harness keeps its own rules file, skills and tools.                                                                                                 |
| A4  | Persistent profiles that build their own memory and KB areas               | **Partly built.** Profiles persist in their own folders on the hub (goal 03). Their own memory notes and skill proposals are goal 14.                                                                                                                                      |
| A5  | Profile X can message profile Y                                            | **Planned** (goal 18), on the MCP tools T3 Code gives agents (doc 05).                                                                                                                                                                                                     |
| A6  | Group chat: one session, all replies and threads replayed between profiles | **Designed** (doc 12); goals 08 and 09.                                                                                                                                                                                                                                    |
| A7  | Reflection over chats creates skills and memory                            | **Planned** (goal 14).                                                                                                                                                                                                                                                     |

## The fleet

| ID  | Requirement                                                                                                                      | Status in Magnesium                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Launch a workload anywhere: native, Kubernetes, Docker or Podman sandbox, microVM; agent running, tools attached, context staged | **Partly built.** Every thread runs fenced, natively or in a container, on any machine (goal 03), and machine servers run in Kubernetes, attached inside workloads (goal 25). Launch from Fleet is goal 10; Kubernetes and microVM sandboxes are goal 19. |
| F2  | Monitor every machine and every agent on it, including autoresearch agents                                                       | **Partly built.** The hub sees every server live (goal 04). Machine and GPU metrics, jobs and autoresearch runs are goals 10 and 17.                                                                                                                      |
| F3  | Specific agents can control, message, steer and change sessions in the fleet                                                     | **Planned** (goal 18).                                                                                                                                                                                                                                    |

## Where agents live

| ID  | Requirement                                                                                     | Status in Magnesium                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| L1  | Main bots and profiles on one central host (the hub)                                            | **Partly built.** The hub runs agents and holds the profiles (goals 02 and 03). Moving existing bots over is goal 21.      |
| L2  | Worker workloads, sessions and sub-agents across the fleet, started by the owner or by the bots | **Partly built.** The owner starts threads on any machine through the hub (goal 02). Profiles starting workers is goal 18. |

## Interaction points

| ID  | Requirement                                                                | Status in Magnesium                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| I1  | Web app for daily use, or a TUI like herdr; "t3code style and simplicity"  | **Built** (goals 01 and 05): the Magnesium web UI, a fork of T3 Code (D1, D5 in doc 09; plan in doc 11).                  |
| I2  | Mobile app with the same features, ChatGPT-like (T3 Code shrunk to mobile) | **Partly built.** The same web UI as a PWA (D10), installed on the desktop (goal 05). Phone layouts and push are goal 07. |
| I3  | Desktop pill: notifications, quick actions, active and waiting agents      | **Planned** (goal 20).                                                                                                    |

## The two overriding goals

| ID  | Goal                                                                                                                       | Meaning for the design                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | At a glance: what is going on, what is priority, where my direction is needed. Time goes to ideating while agents execute. | A home screen ranked by "needs me" and priority. Home ranks what needs you (goal 06, D18).                                                 |
| P2  | As high-level or low-level as wanted, easily.                                                                              | Home's zoom (Glance, Cards, Detail; goal 06) for what needs you, and recaps (goal 26) for a session, between a summary and its transcript. |

## Added by the owner on 2026-10-13

- **T3 Code is the visual and interaction base.** Its look, feel and speed are the target.
- **No terminal or TUI in the UI where possible.**
- **The Collie-based Fuse is a reference, not a base.**
- **The T3 Code fork is called Magnesium** (D27; first named Fuse, D8). It replaces the Collie-based Fuse.
- **Fork T3 Code** rather than use it as is or build from scratch (D5).
- **The Agent SDK path is acceptable to try** (D6, relaxes A2).
- **One client: the Magnesium web UI as a PWA** on desktop and phone (D10). **No never-edit list:** we own the web UI (D11).
- **Group and channel chat on MCP events**, with a small decision model choosing which bots a message is for (D7, doc 12).
