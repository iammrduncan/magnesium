# T3 Code: how it drives each harness, and its remote model

**Result:**

- T3 Code **never drives an agent through a terminal or PTY.** Every harness goes through a structured protocol. The only PTY is a plain shell terminal for the user.
- **Claude** runs through the **Claude Agent SDK**, which spawns the user's own `claude` binary. It is not `claude -p` and not the TUI. T3 uses `claude -p` only to write titles and commit messages.
- It can **import past Claude and Codex sessions** from disk as text and resume them. It **cannot see live sessions it did not start.**
- A **provider instance** has `binaryPath`, `homePath`, `launchArgs` and `environment`. That is a usable hook for Magnesium profiles, with limits.
- It is **MIT** licensed. The codebase is large, moves fast and is built on Effect v4.

**Status:** read from source and docs in the T3 Code repo at commit `380bba36` (2026-10-13), contracts package 0.0.45. **Nothing was run.** Items marked _not verified_ are inferred. No local T3 database was opened.

## 1. How each harness is driven

| Harness         | Mechanism                                                                                   | TUI? | Approvals                                                                                       | Resume                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Claude**      | Agent SDK 0.3.276 (`query()`), spawning the user's `claude` as `pathToClaudeCodeExecutable` | No   | SDK `canUseTool` callback; `AskUserQuestion` and `ExitPlanMode` are answered in it              | `resume` / `sessionId`; fork with the SDK's `forkSession`; `resumeSessionAt` for rollback                        |
| **Codex**       | `codex app-server`, JSON-RPC over stdio (`packages/effect-codex-app-server`)                | No   | Server requests such as `item/commandExecution/requestApproval`; the answer is the RPC response | `thread/resume`, `thread/fork`, `thread/read`                                                                    |
| **Cursor**      | Official `@cursor/sdk`, local agent                                                         | No   | No interactive callback; sandbox and auto-review policy                                         | `Agent.resume`                                                                                                   |
| **Grok**        | ACP over stdio (`grok agent stdio`)                                                         | No   | ACP `session/request_permission`                                                                | ACP `session/load` / `session/fork`                                                                              |
| **OpenCode**    | `opencode serve` over HTTP and SSE, or an external server URL                               | No   | OpenCode permission API                                                                         | Server-side sessions                                                                                             |
| **Pi**          | `pi --mode rpc`, line-delimited JSON                                                        | No   | A T3 extension's blocking tool hook                                                             | Pi's own session file is the thread ref, so it can resume in the Pi TUI and back (concurrent use _not verified_) |
| **Muse**        | `@muse-code/sdk`, `muse serve`                                                              | No   | Supervised or full access only                                                                  | Not examined                                                                                                     |
| **Antigravity** | Google's `antigravity-acp` over ACP, installed and managed by T3                            | No   | ACP permission requests                                                                         | ACP load or resume                                                                                               |
| **Generic ACP** | Any ACP agent from a registry or a local command                                            | No   | Mapped to the thread's permission mode                                                          | `session/load` or `resume` if advertised                                                                         |

Evidence for Claude (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`):

- The SDK call is at `:719`. The prompt is an async queue of user messages (`:679-685`), so one live `claude` process serves a thread and takes streamed input.
- The binary path comes from the instance's `binaryPath` (`:1047-1049`).
- The system prompt is the preset `claude_code` plus an appended T3 block (`:1052-1058`), so Claude Code's own prompt, tools, hooks, skills and settings are kept.
- T3 sets `model`, `effort`, `permissionMode`, `includePartialMessages`, `additionalDirectories`, and passes the instance's `launchArgs` as `extraArgs` (`:948-1068`).
- It sets no API key. It relies on the `claude` binary's own login (README: "works with your subscriptions").
- Changing model, effort or policy closes the process and reopens it with `resume` (`:8300-8335`), and refuses while background tasks run.

Codex (`CodexAdapterV2.ts`): spawn at `:1525-1535`; per-thread config overrides carry the plan-tool flag and T3's MCP server (`:1309-1340`); per-turn policy in `turn/start` (`:658-830`). Model and effort change on every turn with no restart.

**Why this matters for A2** ("native harness, not `claude -p`, not the Agent SDK"): the Agent SDK path keeps the native binary, its login, its system prompt and its tooling. It is still the SDK entrypoint, not the interactive one. Billing is not answerable from code. **Goal 01 checked it (D30):** an SDK session and the CLI both report no API key and the claude.ai five-hour window, so both draw on the subscription meter. The owner accepted this path before the check (D6 in [doc 09](09-decisions-and-open-questions.md)).

## 2. Approvals, questions, plan mode, steering, interrupts

All of it is normalised in `packages/provider-core/src/server/ProviderAdapter.ts`, with a capability record per provider (`docs/orchestration-v2/provider-capability-system.md`).

| Capability | Claude                                                                                                                                 | Codex                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approvals  | `canUseTool`, installed by the permission policy (`ClaudeAdapterV2.ts:1652-1740`). Full access maps to bypass; read-only to `dontAsk`. | Server-initiated requests, answered by RPC response. Modes map to `approvalPolicy`, `sandboxPolicy`, `approvalsReviewer`.                                                       |
| Questions  | `AskUserQuestion` inside `canUseTool`, plus `onUserDialog`                                                                             | `item/tool/requestUserInput`; async questions answered by a new message. T3 persists them across a restart. Live Claude approvals do **not** survive a server restart (`:234`). |
| Plan mode  | `permissionMode: "plan"`; `ExitPlanMode` shown as a proposed plan                                                                      | `collaborationMode: plan` in `turn/start`                                                                                                                                       |
| Interrupt  | `queryRuntime.interrupt()`                                                                                                             | `turn/interrupt`                                                                                                                                                                |
| Steering   | A message with `priority: "now"` pushed into the live queue                                                                            | `turn/steer` with `expectedTurnId`                                                                                                                                              |
| Fork       | SDK `forkSession`, in a separate worker process                                                                                        | `thread/fork`                                                                                                                                                                   |

Cursor can change model between turns but cannot steer or fork. Other ACP agents have no active steering.

## 3. Sessions started elsewhere

- **Import of past sessions: yes, as text.** RPCs `agentSessions.scan` and `agentSessions.import`.
  - It reads `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/*.jsonl` and `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` (`apps/server/src/project/AgentSessionScanner.ts:921-1014`), and honours each instance's `homePath`.
  - Limits: the last 30 days, 100 transcripts per import, 200 messages per thread, user and assistant text only (`:73-96`).
  - Each session becomes a thread with a native **resume cursor**, so the next message resumes the real session (`AgentSessionImporter.ts:343-347`).
  - ACP agents that offer `session/list` have a "Native sessions" import.
- **Live sessions it did not start: cannot see them.** No file watcher, process discovery or hook receiver for outside agents. Confirmed by grep and reading the scanner.
- A resumed thread is a **second process** on the same session id. Whether two writers on one Claude or Codex session are safe is _not verified_.

## 4. Configuration and where profile flags could go

A **provider instance** is `{ driver, displayName?, accentColor?, environment?[], enabled?, config? }`, kept in `settings.json` and editable over the `server.updateSettings` RPC (`packages/contracts/src/providerInstance.ts:100-130`; `apps/server/src/serverSettings.ts:92-165`). Instances route by id, so two Claude instances never share state. Claude supports several instances.

| Setting         | Claude                          | Codex                             |
| --------------- | ------------------------------- | --------------------------------- |
| `binaryPath`    | yes                             | yes                               |
| `homePath`      | exported as `CLAUDE_CONFIG_DIR` | exported as `CODEX_HOME`          |
| `launchArgs`    | parsed into SDK `extraArgs`     | appended after `codex app-server` |
| `environment[]` | name, value, `sensitive` flag   | same                              |

What a profile could use:

- `--append-system-prompt-file`, `--mcp-config`, `--settings`, `--plugin-dir` can go in `launchArgs`. **Limits:**
  - A repeated flag keeps only the last value (`packages/shared/src/cliArgs.ts:92-129`), so several `--plugin-dir` entries collapse.
  - T3 also sets its own `systemPrompt.append` and `settings`. A user flag may duplicate or clash (_not verified_).
  - **`--permission-mode` and `--dangerously-skip-permissions` override the thread's mode.** T3 removes them from the extra args, but uses their value in place of the thread's runtime mode, plan mode included (`ClaudeAdapterV2.ts:975-1014`; tested in `ClaudeAdapterV2.test.ts:254-269`). So an instance's launch args can force `bypassPermissions` for every thread. **Magnesium must never write these flags into an instance**, and `magnesium-agents check` refuses them (goal 03).
- **A wrapper script as `binaryPath` is the most robust hook.** A path without a script extension (`.js`, `.mjs`, `.ts`, `.tsx`, `.jsx`; `ClaudeAdapterV2.ts:223`) is treated as a native binary. On Linux, T3 wraps it in a `/bin/sh` exec shim that raises its OOM score, optionally under `systemd-run --scope` (`packages/shared/src/AgentScope.ts:74-128`), and the SDK spawns that (`ClaudeAdapterV2.ts:691-714`). So a shell wrapper needs the exec bit and a shebang. A `.js` path is run with node or bun instead, and skips the shim. A launcher doing `exec claude <profile flags> "$@"`, or entering a container, can sit in front. _Not verified end to end._
- A **per-profile `CLAUDE_CONFIG_DIR`** gives most profile behaviour with no flags: plugins, skills, hooks and `CLAUDE.md` come from the native config dir.
- There is no per-session or per-project hook to inject arbitrary args. Project overrides cover things like default model and permissions.
- Users cannot add extra MCP servers through T3; they come from the harness's own config.

**How T3's own MCP server reaches each harness:**

| Harness  | Path                                                                                                                       | Token in argv?                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude   | SDK `setMcpServers` over the stdin control channel (`ClaudeAdapterV2.ts:686-731`)                                          | **No.** The code comments say this is to keep it out of argv and child env. |
| Codex    | JSON-RPC params in `thread/start`, `http_headers.Authorization` (`:1321-1340`)                                             | No                                                                          |
| OpenCode | Its HTTP API, `client.mcp.add` with an `Authorization` header (`packages/provider-opencode/src/server/adapter.ts:975-984`) | No                                                                          |
| Pi       | Environment variable `T3_MCP_BEARER_TOKEN` (`packages/provider-pi/src/server/mcpInjection.ts:313`)                         | Env, not argv                                                               |

`docs/orchestration-v2/orchestrator-mcp-server.md` still describes a Codex `T3_MCP_BEARER_TOKEN` mechanism that is **not in the Codex source**: that doc is stale.

**Claude's MCP token is out of argv.** Upstream moved Claude's MCP servers from an inline `--mcp-config` argument to the stdin control channel on 2026-10-10 (commit `f82796a16`, PR #17898), so the bearer token no longer appears in argv. The stable `v0.0.45` lacked the fix. Magnesium ported it by hand, and `v0.1.0`, which Magnesium has merged, includes it (see [`upstream-changelog.md`](../../upstream-changelog.md)).

**Secrets:** sensitive env values and the Antigravity API key go into T3's own secret store on the host (`packages/contracts/src/settings.ts:767-772`; `apps/server/src/settingsSecrets.ts:24-27`). A second store conflicts with "secrets pass by name only". A wrapper that reads secrets by name from its own environment avoids it.

## 5. Remote architecture

- **Transport:** one Node server; Effect RPC over a WebSocket at `/ws` (`apps/server/src/ws.ts:3174-3208`), plus HTTP routes for assets, auth and `/mcp`. The contract is `packages/contracts/src/rpc.ts`.
- **Environments:** a server is one environment with a stable ID. A client holds many, each with an ordered list of routes (LAN, Tailscale, SSH, T3 Connect, public URL) and tries them in order (`docs/internals/remote.md`; `packages/client-runtime/src/connection/driver.ts`). **There is no cross-environment routing**; a client-side balancer picks an environment for new threads.
- **Auth** (`docs/internals/environment-auth.md`): each environment issues its own sessions. A one-time pairing link exchanges for a bearer token, cookie or DPoP-bound token. WebSocket upgrades use short-lived tickets. Every RPC declares a required scope.
- **Scopes** (`packages/contracts/src/auth.ts:82-117`): `orchestration:read|operate`, `settings:write`, `providers:manage`, `environment:maintain`, `terminal:*`, `filesystem:read|write`, `source-control:write`, `access:*`, `relay:*` and others. `filesystem:read` can read any file the server account can.
- **Tailscale** is a route: the package drives `tailscale status` and `tailscale serve`. **SSH** forwards a port and can start the server on a remote host.
- **T3 Connect** needs a cloud identity provider and a hosted relay run by T3 Tools. Traffic then goes through the environment's own tunnel. A fork would skip it and use Tailscale or direct pairing.
- **Hosted web client** (`app.t3.codes`) is only a client that connects straight to environments.

## 6. Scheduled tasks

`apps/server/src/scheduledTasks/ScheduledTaskService.ts`, `Schedule.ts`, `webhookRoute.ts`; contract `packages/contracts/src/scheduledTask.ts`.

- **Not a special headless path.** A run calls the same thread-launch or send-to-thread service as a user message, so the normal adapters, instances and permission modes apply (`ScheduledTaskService.ts:790-830`).
- **Configurable per task:** title, prompt, enabled, schedule (interval of at least 60 s, fixed time with weekdays, or webhook with optional HMAC check and prompt templating), project, optional bound thread, workspace strategy, model selection (names the instance), runtime mode and interaction mode.
- **Not configurable per task:** extra flags or env beyond the instance. A missed fixed-time slot is skipped, not run late.
- Agents can manage tasks through MCP (`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`).

## 7. The MCP server ("outside agents")

- Endpoint `<environment>/mcp`. Outside agents sign in with OAuth 2 and PKCE; the user grants read-only or a runtime-mode ceiling; tokens last 30 days (`docs/user/outside-agents.md`). Agents without OAuth cannot connect (_no static token documented_).
- About 80 tools (`apps/server/src/mcp/toolkits/**`). Groups:
  - **Threads:** list, read, search, launch, send, interrupt, wait, fork, configure, organise, merge back.
  - **Delegation:** `delegate_task`, `task_status`, `task_cancel`.
  - **Pending requests (approvals and questions):** list, read, respond.
  - **Queue:** list, edit, cancel, reorder, promote to steer.
  - **Projects and worktrees, scheduling, pull requests, previews, devices, HTML render, secret requests.**
- **For Magnesium:** a bot could list threads, launch one on a chosen instance, steer it, wait, and answer approvals. That works **only for threads T3 owns.**

## 8. Persistence

- Base `~/.t3`; state in `userdata/`: `statev2.sqlite`, `settings.json`, `keybindings.json`, `environment-id`, `secrets/`, `attachments/`, `logs/`. Native protocol logs go to `logs/provider/events.log`. Raw provider frames are not durable state.
- **Event-sourced.** `orchestration_v2_events` (sequence, command id, thread, run, node, provider, type, payload JSON) plus `orchestration_v2_command_receipts` (`Migrations/055_OrchestrationV2.ts:23-35`).
- **Projection tables:** threads, runs, run attempts, nodes (execution tree), provider sessions, provider threads, provider turns, runtime requests (pending approvals and questions), messages, plans, turn items, checkpoints, context handoffs and transfers.
- **Entity model:** Project → AppThread → Run → ExecutionNode tree. A ProviderThread (native handle) and a ProviderSession (process) are separate from the AppThread (`docs/orchestration-v2/core-graph-and-data-model.md`).
- **Reuse:** read-only SQL is possible, but the schema is internal and has 57+ migrations with no stability promise. The supported interfaces are the WebSocket RPC and MCP.

## 9. Licence and forkability

- **MIT**, copyright T3 Tools Inc. No CLA or trademark policy found. Using the name or mark in a fork is a legal question **not researched**.
- `CONTRIBUTING.md`: "not actively seeking outside contributions". Upstreaming a fleet layer is unlikely; a fork carries its own patches. `AGENTS.md` and the README invite forking.

| Module                        | Size (non-test TS, approx.) | Notes                                                                              |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `packages/contracts`          | 27.6k lines                 | Depends only on `effect`. `private`, source exports. Clean to vendor.              |
| `packages/client-runtime`     | 39.8k lines                 | Platform-neutral connection, state and operations. Effect v4 and atoms throughout. |
| `apps/web`                    | 258k lines                  | React; depends on a hosted identity SDK.                                           |
| `apps/server`                 | 218k lines                  | Adapters, orchestrator, auth, MCP, scheduler, git and PR features.                 |
| `apps/mobile`, `apps/desktop` | 130k, 42k lines             | React Native; Electron.                                                            |

The Claude adapter alone is 9.4k lines and the Codex adapter 7.4k: a sign of the long tail (background tasks, subagents, goals, restart recovery). Drivers are pluggable: `ProviderDriverKind` is an open slug and there is an "adding a provider" guide (`docs/internals/adding-a-provider.md`).

Hard dependencies on third-party services exist in some paths (an identity SDK, the hosted relay, product telemetry, `app.t3.codes`). All are optional for a self-hosted server but need stripping in a branded fork.

## 10. Options for a harness UI

|                                | A. Use T3 Code as is                                                                     | B. Fork T3 Code                             | C. Own UI on T3's contracts and client runtime                          | D. Build from scratch                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Idea**                       | A profile tool writes provider instances from profiles; T3 is the UI.                    | Add fleet, KB and profile layers inside T3. | A new front end speaks T3's RPC to unmodified T3 servers, one per host. | Own server and UI, borrowing T3's designs.                          |
| **Effort**                     | Lowest                                                                                   | High, then a standing merge cost            | Medium                                                                  | Highest                                                             |
| **Keeps T3's adapters**        | Yes                                                                                      | Yes                                         | Yes (server side)                                                       | No: re-implement them                                               |
| **Fleet and KB view**          | No                                                                                       | You build it                                | You build it                                                            | You build it                                                        |
| **Sees herdr or TUI sessions** | No                                                                                       | Only if you add it                          | No, unless we add a session source                                      | By design                                                           |
| **Sandbox and profile rules**  | Bypassed unless a wrapper `binaryPath` enters a container, or T3 runs inside the sandbox | You add it in the adapter layer             | One T3 server per sandboxed host                                        | By design                                                           |
| **Upstream**                   | Follows releases                                                                         | Upstream will not take changes              | Pin a server version                                                    | None                                                                |
| **Main risk**                  | Two parallel worlds; secrets stored in T3's store                                        | Large Effect-v4 code base                   | Vendoring private packages; Effect comes with them                      | The long tail of adapter bugs; needs the SDK (breaks "only `yaml`") |

**My reading, not verified by running anything:**

- **A plus a thin bridge is the cheapest experiment.** It measures the billing question and the real feel before committing.
- For a long-lived product, **C** (own UI over T3's contracts and servers) or **D** (own adapters borrowing T3's designs: capability records, command receipts, per-instance isolation, MCP over stdin or JSON-RPC rather than argv). **B** only if we accept carrying the whole code base.

**Decided 2026-10-13: B.** The owner chose to fork (D5), because the interface "doesn't meet all our demands and it is missing critical features". [Doc 11](11-fork-plan.md) plans how to keep the cost of carrying it low.

## Cheap checks before choosing

1. Run an SDK-spawned Claude session with a wrapper `binaryPath` that enters a container.
2. Check whether `--append-system-prompt-file` or `--settings` in `launchArgs` clashes with T3's own options.
3. Confirm Anthropic's billing for Agent-SDK-spawned `claude` sessions on a subscription.
4. Test whether a herdr TUI and a T3 thread can safely share one Claude session id.
5. The MCP-token-in-argv finding: **checked**. Fixed upstream on 2026-10-10, and in Magnesium since goal 01 (section 4).
