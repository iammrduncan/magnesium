# Requirements, numbered

This restates [`requirements.txt`](requirements.txt) with IDs, and says what existed for each line in dBrain, the owner's earlier harness, on 2026-10-13. That file is a copy of the owner's requirements.

**Status words:** _built_ (code or a working deployment), _designed_ (a doc, no code), _partial_, _missing_. "Verified" is used only where the repo says how it was checked.

## The five parts of the harness

1. KB / brain / memories
2. Agent loops
3. Persistent profiles, context and self-learning
4. Infrastructure and fleet management
5. Custom mini apps: plugin-style, serving dashboards and new features

## KB

| ID  | Requirement                                                                                                                                                           | What exists                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | Persistent, organised wiki KB with vector and hybrid search                                                                                                           | **Built** (GBrain, with embedder, reranker and search tuning).                                                                                           |
| K2  | Many sync modules that collect data into the KB                                                                                                                       | **Built**: session collector, repo crawl and mirror, social feeds, books, voice dictation, chat-export converter. Each doc says whether it was verified. |
| K3  | Nightly "dreaming": memory creation and curation                                                                                                                      | **Designed and documented.** Not yet verified on a live GBrain.                                                                                          |
| K4  | Ingestion pipelines: a link, a Hugging Face page, a PDF and so on → research → raw data, raw research, synthesised answer, "why it matters to me" by area and project | **Partial.** Intake and safe fetch exist; the full research-and-relevance pipeline is not documented as built.                                           |
| K5  | Project-based knowledge and organisation                                                                                                                              | **Partial.** Topics and save flows exist. A `/projects/<name>` space per UI project is not built.                                                        |
| K6  | Individual and team memory and facts                                                                                                                                  | **Built** as three tiers: a project's auto memory, a personal KB memory page, and team facts. Precedence is defined.                                     |
| K7  | Auto-learning from sessions                                                                                                                                           | **Designed.** Session shipping to the KB is built.                                                                                                       |

## The agent interface (the UI)

| ID  | Requirement                                                                                                        | What exists                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Bot mode:** channels and DMs with long-running sessions                                                          | **Designed.** No UI. An earlier PWA plan covered it for one bot gateway only.                                                          |
| M2  | **Project mode:** folders with their own sessions; extra docs dropped in and saved to `/projects/<name>` in the KB | **Missing.**                                                                                                                           |
| M3  | **Session mode:** one-off chats backed by general memory and the KB                                                | **Missing as a UI.** The agent side works (`dbrain launch`).                                                                           |
| M3a | In project and session mode, pick the profile and harness per session, with a default                              | **Partial.** `dbrain launch --harness` exists; no UI.                                                                                  |
| M4  | **Fleet mode:** every active session and job across the cluster                                                    | **Partial.** herdr sees live sessions; a session list is planned; no jobs view.                                                        |
| M5  | **App mode:** list of apps, pin the ones that matter                                                               | **Missing.**                                                                                                                           |
| M6  | **Scheduler mode:** view, create and change scheduled jobs and agent runs                                          | **Partial.** `SCHEDULE.yaml`, `dbrain schedule tick`, and `list_schedule` / `run_task` in the API. No create or edit operation, no UI. |

## The agents

| ID  | Requirement                                                                | What exists                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Works with any harness (Claude Code, Codex, OpenCode, Pi, oh-my-pi, …)     | **Partial.** In dBrain, Claude Code and Codex are built, omp is experimental, and OpenCode and Pi are missing. T3 Code, the fork base, has drivers for Claude, Codex, Cursor, Grok, OpenCode, Pi, Muse, Antigravity and any ACP agent, but **none for omp** (doc 08; open as O12). |
| A2  | Uses the native harness. **Not** `claude -p`, **not** the Agent SDK        | **Relaxed by the owner (D6, doc 09).** It clashed with "no TUI in the UI" (D3). T3 Code drives Claude through the Agent SDK, which spawns the native `claude` binary with its own login, prompt and tools. The owner will try that path.                                           |
| A3  | Uses each harness's built-in tooling, which the models are trained on      | **Built** by design: dBrain passes the profile through the harness's own flags.                                                                                                                                                                                                    |
| A4  | Persistent profiles that build their own memory and KB areas               | **Built** (profile folder, `memory/`, `MEMORIES.md`). Per-profile memory loading has a known gap.                                                                                                                                                                                  |
| A5  | Profile X can message profile Y                                            | **Partial.** `prompt_agent` over REST and MCP works. There is no routing, inbox or reply model.                                                                                                                                                                                    |
| A6  | Group chat: one session, all replies and threads replayed between profiles | **Designed** (`rooms.md`).                                                                                                                                                                                                                                                         |
| A7  | Reflection over chats creates skills and memory                            | **Designed.**                                                                                                                                                                                                                                                                      |

## The fleet

| ID  | Requirement                                                                                                                      | What exists                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Launch a workload anywhere: native, Kubernetes, Docker or Podman sandbox, microVM; agent running, tools attached, context staged | **Partial.** Sandboxes `none`, `native`, `container`, `microvm` are built. Kubernetes launch and context staging across machines are not. |
| F2  | Monitor every machine and every agent on it, including autoresearch agents                                                       | **Partial.** Machine metrics and dashboards exist outside the harness. Agent and autoresearch status is not in one view.                  |
| F3  | Specific agents can control, message, steer and change sessions in the fleet                                                     | **Partial.** `prompt_agent` is owner-level; agent-to-agent control rules are not defined.                                                 |

## Where agents live

| ID  | Requirement                                                                                     | What exists          |
| --- | ----------------------------------------------------------------------------------------------- | -------------------- |
| L1  | Main bots and profiles on one central host (the hub)                                            | **Built** in dBrain. |
| L2  | Worker workloads, sessions and sub-agents across the fleet, started by the owner or by the bots | **Partial.** See F1. |

## Interaction points

| ID  | Requirement                                                                | What exists                                                                  |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| I1  | Web app for daily use, or a TUI like herdr; "t3code style and simplicity"  | **Missing.** Decision: a fork of T3 Code (D1, D5 in doc 09; plan in doc 11). |
| I2  | Mobile app with the same features, ChatGPT-like (T3 Code shrunk to mobile) | **Missing.** Decision: the same Magnesium web UI, installed as a PWA (D10).  |
| I3  | Desktop pill: notifications, quick actions, active and waiting agents      | **Missing.**                                                                 |

## The two overriding goals

| ID  | Goal                                                                                                                       | Meaning for the design                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1  | At a glance: what is going on, what is priority, where my direction is needed. Time goes to ideating while agents execute. | A home screen ranked by "needs me" and priority. Nothing in the repo ranks priority yet.                             |
| P2  | As high-level or low-level as wanted, easily.                                                                              | One control that moves between summary, card, transcript and raw detail. First idea in doc 10; open as O6 in doc 09. |

## Added by the owner on 2026-10-13

- **T3 Code is the visual and interaction base.** Its look, feel and speed are the target.
- **No terminal or TUI in the UI where possible.**
- **The Collie-based Fuse is a reference, not a base.**
- **The T3 Code fork is called Magnesium** (D27; first named Fuse, D8). It replaces the Collie-based Fuse.
- **Fork T3 Code** rather than use it as is or build from scratch (D5).
- **The Agent SDK path is acceptable to try** (D6, relaxes A2).
- **One client: the Magnesium web UI as a PWA** on desktop and phone (D10). **No never-edit list:** we own the web UI (D11).
- **Group and channel chat on MCP events**, with a small decision model choosing which bots a message is for (D7, doc 12).
