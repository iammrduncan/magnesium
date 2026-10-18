# T3 Code: what it is and how it is built

**Result:** T3 Code is an open-source "agent harness control surface": one server per machine, plus web, desktop and mobile clients that talk to it over typed WebSocket RPC. It keeps a structured event log per thread instead of mirroring a terminal. That is the opposite of the terminal-mirror approach, and it is why it feels fast and why it can show clean transcripts, approvals and diffs.

Sources: a read-only clone of the T3 Code repo at commit `380bba36` (2026-10-13): `README.md`, `AGENTS.md`, `docs/internals/*`, `docs/orchestration-v2/*`, `docs/user/*`. Licence: MIT, copyright T3 Tools Inc. (`LICENSE`, read).

## What it is

| Fact                                                                                                                                                                                                    | Evidence                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A "minimal GUI for coding agents". A Node WebSocket server wraps provider CLIs and agents and serves web, desktop and mobile clients.                                                                   | `AGENTS.md`                        |
| Bring your own subscription. Works with Claude Code, Codex, Cursor, Grok Build, OpenCode and Antigravity; Pi and Muse and a generic ACP provider also have packages.                                    | `README.md`; `packages/provider-*` |
| Three surfaces: web (the hosted app and the locally served one), an Electron desktop app that can also host the server, and a React Native mobile app (iOS and Android) that connects to any T3 server. | `AGENTS.md`, "Multi-surface"       |
| Four stated non-negotiables: open at the core, **performance without compromise**, remote ready, multi-surface.                                                                                         | `AGENTS.md`                        |
| Most contributions come from T3 Code itself, often controlled remotely.                                                                                                                                 | `AGENTS.md`                        |
| The maintainers' design stance: "the smallest model that makes the correct behavior unsurprising"; no machinery "because it looks architecturally impressive".                                          | `AGENTS.md`, the maintainers' note |

## The shape

```text
 clients (web · desktop · mobile)           share logic in packages/client-runtime
        │  typed WebSocket RPC (packages/contracts)
        ▼
 server (one per environment: machine + files + credentials)
   ├─ Orchestrator     serialises commands, decides events, no I/O
   ├─ Event sink       one DB transaction: events + projections + receipt + outbox
   ├─ Effect worker    runs side effects after commit (start a turn, checkpoint)
   ├─ Provider adapters one per harness; translate native protocol ↔ normalised events
   ├─ Checkpoints      hidden git refs, so every turn can be diffed and restored
   └─ MCP endpoint     lets agents list, read, create and steer threads
        │  subprocess
        ▼
 provider CLIs and agents (Codex app-server, Claude, Cursor, Grok, OpenCode, ...)
```

Read from `docs/internals/overview.md` and `AGENTS.md` ("How it works").

## Terms (from its glossary)

| Term                                                      | Meaning                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Environment**                                           | One running server plus the machine, credentials, workspace access and state it owns. A remote client never uses its own filesystem or credentials in place of the environment's.                                  |
| **Project**                                               | An environment-local workspace record rooted at a directory.                                                                                                                                                       |
| **Thread**                                                | The durable conversation and work history for a project. It outlives provider processes.                                                                                                                           |
| **Turn / run**                                            | One user-to-agent cycle. Provider work can end before checkpoint and diff work settles.                                                                                                                            |
| **Activity**                                              | A non-message timeline item: a tool action, approval or failure.                                                                                                                                                   |
| **Provider, driver, provider instance, adapter, session** | The harness; the integration for a kind of harness; one configured copy of it with its own settings; the translation boundary; the runtime attached to a thread (can stop and resume without deleting the thread). |
| **Runtime mode vs interaction mode**                      | Permission policy vs how the agent approaches the task (for example planning). Kept separate.                                                                                                                      |
| **Checkpoint**                                            | A saved workspace state as a hidden git ref, used for diffs and restore.                                                                                                                                           |

## Ideas in T3 Code that match our requirements

| Idea                                                                       | What it is                                                                                                                                                                                                                                                                                                                   | Matches                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Provider instances**                                                     | Several configured copies of one harness, each with its own settings.                                                                                                                                                                                                                                                        | Profiles (A4): profile sync writes one instance per profile (doc 11).     |
| **Provider switching inside one thread**                                   | A thread can hold runs from several providers. The app thread is canonical; each provider keeps its native thread; a handoff artifact carries what the other provider missed.                                                                                                                                                | M3a, "pick the harness per session", and a cheap kind of group work (A6). |
| **Context handoff is a budgeted selection, not an agent-written summary.** | Recent turns, the original request and key outcomes, capped at a token budget (default 16,000), with references to omitted history the agent can fetch through a thread-reading tool.                                                                                                                                        | An earlier design for rotating and handing off long sessions.             |
| **Fork and merge-back**                                                    | Forking creates a new thread with recorded lineage and resolves context lazily at first use. Merge-back sends only the delta.                                                                                                                                                                                                | Project work and exploration.                                             |
| **Agent-reachable orchestration over MCP**                                 | An authenticated MCP endpoint lets a running agent create sub-agents on any provider instance, create or list threads, read them incrementally, send or steer messages, and wait on or interrupt runs. Credentials are scoped to the environment, thread, instance and session, expire when idle and are revoked on release. | A5 and F3: agents messaging and steering agents.                          |
| **Capability-driven features**                                             | Features check explicit provider capability flags, not provider names. Missing capability is handled by policy.                                                                                                                                                                                                              | A1 (any harness).                                                         |
| **Scheduled tasks**                                                        | A server-side scheduler runs agent tasks without a client.                                                                                                                                                                                                                                                                   | M6. Details in doc 07 and 08.                                             |
| **Multiple environments in one client**                                    | Settings and state stay with the owning server. A client can connect to several.                                                                                                                                                                                                                                             | Fleet (M4, L2).                                                           |
| **Remote ready**                                                           | Direct, tailnet and tunnel connection modes; device pairing.                                                                                                                                                                                                                                                                 | I1, I2.                                                                   |
| **Mobile as a first-class client**                                         | A native app, not a shrunk web page.                                                                                                                                                                                                                                                                                         | I2.                                                                       |

## What T3 Code does not claim to be

- A knowledge base or memory system.
- A fleet view over many servers in one list (clients connect to several environments, but a ranked "needs me" across all of them is not described in the docs read so far).
- A scheduler of work across machines with sandboxes and staged context.
- An app or plugin host for custom dashboards.

Doc 07 lists the gaps in detail.

## Things to check against the code (done in docs 06 to 08)

Answered in doc 08:

- **Claude is driven through the Claude Agent SDK**, which spawns the native `claude` binary. No terminal. That conflicts with requirement A2 as written; the owner accepted trying it (D6, doc 09).
- **T3 cannot see live sessions it did not start.** It can import past Claude and Codex sessions from disk as text and resume them.
- **A profile's flags can be passed** through a provider instance (`launchArgs`, `binaryPath`, `homePath`, `environment`), with limits.

## Status

Read from docs and one clone. Not run. Re-check the details before building on them.
