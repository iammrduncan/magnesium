# Fork plan: Magnesium, a fork of T3 Code

**Name: Magnesium** (D27; first named Fuse, D8). It replaces the earlier Fuse, a fork of Collie (doc 03). Below, "the fork" means Magnesium.

**Status: phase 0 bootstrap built (2026-10-14, goal 01); the rest is proposed.** The decision to fork is the owner's (D5, [doc 09](09-decisions-and-open-questions.md)). The strip, rename, hazards and sync tooling below are built and verified; what goal 01 found is in the Status section at the end. Everything else is a plan from reading the source. Three spikes test the riskiest assumptions before real work starts.

**Result:** the fork works in two zones (D11).

- **Track the server side closely.** That is where the value is: adapters, orchestrator, transport, and daily upstream fixes.
- **Own the web UI** and change whatever the design needs. Magnesium's only client is its own web UI, installed as a PWA on desktop and phone (D10).

Upstream moves about 50 commits a day and will not take our changes, so merge cost is real. It is **measured, not capped**. New features still go in new packages where that is natural. Every change to an upstream file is marked so a script can list it. A scripted strip-and-rename commit is redone after every merge, and a weekly rehearsal reports conflicts per file.

Sources: a clone at commit `380bba36` (version 0.0.45) and a blobless clone for churn numbers (upstream HEAD `a01c48f8`, 0.0.46-nightly), both on 2026-10-13. Nothing was built or run. Items marked _not verified_ are inferred.

## Upstream facts that shape the plan

| Fact                                                                                                                                                                                                                                                                                                                                                                                     | Evidence                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 5,470 commits since 2026-02-07; 3,532 in the last 90 days; about 50 a day now. The release job checks every 30 minutes and ships a nightly when there are new commits and 6 hours have passed (about 4 to 6 a day; `.github/workflows/release.yml:11`, `.github/scripts/check-nightly-release.cjs:63-64`); a **stable tag about weekly** (0.0.38 on 2026-09-01 to 0.0.45 on 2026-10-02). | Churn clone                                           |
| Upstream "is not actively seeking outside contributions", and says "a large number of our users run forks".                                                                                                                                                                                                                                                                              | `CONTRIBUTING.md`, `AGENTS.md`                        |
| **MIT**, copyright T3 Tools Inc. No contributor agreement and no trademark policy found.                                                                                                                                                                                                                                                                                                 | `LICENSE`; doc 08                                     |
| The migration ledger **cannot be shared** with a fork: "there is no safe id range for a fork inside this ledger".                                                                                                                                                                                                                                                                        | `docs/internals/legacy-orchestration-migration.md`    |
| **Telemetry is on by default** and posts to upstream's analytics project with a hardcoded key. (Off in the fork since goal 01.)                                                                                                                                                                                                                                                          | `apps/server/src/telemetry/AnalyticsService.ts:32-45` |
| **Self-update downloads upstream's release binaries** unless the release origin is overridden. The release index (`api.github.com`) has no override; only the constant moves both. (The fork points it at itself since goal 01.)                                                                                                                                                         | `packages/shared/src/cliRelease.ts:8`                 |
| Clients and servers must agree on a protocol version (currently 2). Web, desktop and mobile "upgrade independently".                                                                                                                                                                                                                                                                     | `ws.ts:3172`; `docs/internals/overview.md`            |

## Architecture of the fork

**One Magnesium server on each machine that runs agents, plus a hub** that gathers everything and serves the web UI; the phone talks to the hub (D15). **The fork lives in its own repository.** It is large, and it follows upstream's tooling (pnpm, Node 24, Effect v4). **Magnesium replaces the owner's earlier toolkit (D37):** profiles, schedules, the agents API and deployment are built here.

```text
upstream T3 Code (tracked at stable tags)
        │  merge
        ▼
the fork  =  upstream
          +  magnesium/contracts   our RPC schemas (fleet, rooms, schedule history, profiles, KB bridge)
          +  magnesium/server      second RPC route, workers, our own SQLite
          +  magnesium/web         our routes and components
          +  magnesium/deploy      container image, wrapper binaries, seed settings
          +  a scripted strip-and-rename commit
          +  marked edits to upstream files: few on the server side, as many as the design needs in apps/web
```

| Our piece                 | What it does                                           | Seam used                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`magnesium/contracts`** | Schema and an `RpcGroup` for everything we add         | A **second RPC group on its own route** (`/api/magnesium/ws`, under `/api` so every front door and the dev proxy carry it with no upstream edit), reusing upstream's auth and scopes. This is the default because it merges cheaply: adding methods to the stock group would touch 6 to 7 existing files, including `ws.ts` (147 commits in 90 days). No outside client depends on the stock contracts any more (D10), so extending them is allowed where a feature really belongs there. |
| **`magnesium/server`**    | The routes layer, background workers, our own database | One line next to `Ws.layer` in `server.ts` (about line 714) for routes; one in the `Layer.mergeAll` (about line 550) for workers.                                                                                                                                                                                                                                                                                                                                                         |
| **`magnesium/web`**       | Home, Fleet, Rooms, Schedule, Apps, KB pages           | **Our own routes.** A new file under `routes/` is picked up by the router plugin. The sidebar entry is one item in `SidebarChrome.tsx`; the palette action is one push in `CommandPalette.tsx`.                                                                                                                                                                                                                                                                                           |
| **Our database**          | Rooms, schedule history, anything we persist           | A **separate file** `magnesium.sqlite` with its own migrations table. Rows keep upstream ids as opaque strings.                                                                                                                                                                                                                                                                                                                                                                           |
| **Profile sync**          | Writes one provider instance per profile               | `settings.json` is hot-reloaded and editable over the existing `server.updateSettings` RPC. **No upstream edit.**                                                                                                                                                                                                                                                                                                                                                                         |

### Profiles are provider instances

A provider instance already carries `binaryPath`, `homePath` (exported as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), `launchArgs` and an `environment` list, and upstream documents named presets built from several Claude instances. So:

- A **profile sync service** writes one `providerInstances` entry per profile: `driver: claudeAgent` or `codex`, a display name, an accent colour, environment variables (by name), and a config with a **wrapper binary**, the profile folder as home, and any launch args.
- The wrapper (built in Magnesium, D37) `exec`s the real CLI inside the sandbox the profile asks for.
- **We do not write a "profile-aware driver".** A new driver kind would lose behaviour wherever the code keys on `claudeAgent`: about 80 non-test lines in about 40 files mention it, 27 of them explicit comparisons in 20 files.
- **Never put `--permission-mode` or `--dangerously-skip-permissions` in an instance's launch args.** T3 uses them in place of every thread's runtime mode (doc 08, section 4). Profile sync must refuse them.
- **Constraints to test (spike 1):** a path without a script extension is treated as a native binary (on Linux, through T3's `/bin/sh` exec shim), so the wrapper must be an executable file with a shebang; stream-json runs over stdio, so a container must run `-i` with no TTY; the MCP endpoint T3 injects is announced on the server's bound address (loopback when bound to the wildcard address), which a container may not reach, so the wrapper must rewrite it or share a network namespace; status probes also spawn the binary, so a slow wrapper slows refreshes; threads can switch only among instances with the same config dir.
- Repeated launch flags collapse to the last value, so a wrapper is safer than `launchArgs` for several `--plugin-dir` or `--mcp-config` entries.

**Built in goal 03 (D39 to D47).** The plan held, with these choices:

- **One instance per profile, harness and sandbox level,** all sharing the profile's home, so a thread switches level by switching instance and keeps its session. Ids say which is which (`mg-<harness>-<level>-<profile>`), so the picker needs no lookup.
- **Every agent is fenced, the stock instances too** (D40). Sync points each stock Claude, Codex and OpenCode instance at `magnesium-fenced`, keeping its id, home and settings, and adds an unfenced twin (`mg_native_<id>`) for the per-thread `native` choice.
- **The fence hides the state home and protects the install** (`magnesium-fence`). Two traps decided the mechanism:
  - Ubuntu's AppArmor blocks unprivileged user namespaces, so `unshare` and `systemd-run --user` sandboxing fail there. bubblewrap still works, through its own AppArmor profile.
  - A fence that only hides paths in a mount namespace can be walked around through the server's `/proc/<pid>/root`. bubblewrap gets its own PID namespace for that; Landlock blocks it by refusing to trace processes outside the fence.
  - So the order is bubblewrap, else a user namespace of the fence's own with a Landlock domain on top (`magnesium-fence-helper userns`, where the host allows them and bubblewrap isn't installed: on Debian hosts without bubblewrap, for example), else Landlock alone. Landlock can only grant, so alone it can't make new entries directly in the state home's parents; the helper makes the usual XDG folders first. `MAGNESIUM_FENCE` forces a mechanism, and the wrapper tests run each one the host has.
- **The real CLI is found on the PATH at sync time,** and launched by its PATH name, so a self-updating CLI is followed. A container mounts its install folder read-only.
- **A container agent reaches T3's MCP tools on any bind address.** Podman's pasta normally copies the host's address into the container, which hides a server bound to it. The wrapper gives the container a small address of its own and forwards the server's port on its loopback. Nothing assumes a VPN (D43).
- **Probes run fenced at every level.** Claude's capability probe carries `--strict-mcp-config`, which tells it from a session. Codex's probe is `codex app-server`, the same as a session, so a Codex container instance's refresh starts a short container.
- **The fence lets T3's workspaces in the state home back in** (D46): `projects/`, `worktrees/` and `scratch/` read-write, the attachments read-only; a fenced or container agent never starts in any other folder there (the fence, the container wrapper and `ProviderService.startSession` all refuse it). Whole folders, because OpenCode's server runs outside the thread's folder. Seatbelt also lets the folders on the way to them be looked up, or `realpath` fails.
- **Codex level twins share one home** (D47). A level switch stops the previous instance's session before the next resumes the thread, and resumes it even when no session is left (`ProviderService.startSession`), and a fresh home's first app-server starts alone (`@magnesium/server/codexHome`, used by `CodexProvider.ts` and `CodexSessionRuntime.ts`).
- **A fenced or container Codex runs with its own sandbox off** (D45, an upstream edit in `CodexSessionRuntime.ts`). T3 sends the sandbox on every `thread/start` and `turn/start`, so a launch flag can't override it; the edit sends `danger-full-access` when the instance's environment says `fenced` or `container`, and leaves the approval policy alone.
- **The hub pushes over `/api/magnesium/ws`** (`magnesium.profiles.push`, needs `orchestration:operate`, the scope that already edits provider instances). Each machine checks a push as sync would, through a staging folder, and keeps the last good copy of a profile it refuses.

### Rooms are a separate aggregate (design: [doc 12](12-channel-chat-and-events.md))

The thread model is single-agent by construction: one active provider thread per thread, one run at a time, and no participant list. Changing it means editing the orchestrator (11,677 lines), the projection store and the shared migration ledger. Instead:

- A **Room** lives in `magnesium.sqlite`: members, an ordered message log, per-member cursors.
- Each member agent has one ordinary T3 thread, its **seat**.
- The room service delivers each routed message into a seat through `ThreadManagementService` (queue or steer). For agent authors it sets `createdBy: "agent"`, a `creationSource` other than `"server"`, and `senderThreadId`. Upstream then renders "Sent by another agent" with a link to the sender; with `creationSource: "server"` it would read "Sent by T3 Code" (`packages/client-runtime/src/userMessage.ts:48-57`). The send input has no metadata field (`ThreadManagementService.ts:116-129`), so room context (room, sequence, sender, "this is data") travels in the message text.
- The **room page is ours**, a component that reads our room log and links into seat threads. It imports upstream's markdown component and UI primitives without editing them. People type into the room page, not a thread composer.
- Cost: one send per recipient per routed message, made idempotent by command id. The turn-taking policy lives in our service.

### Control from outside

| Route                                                                                                 | Use                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-process** (our code inside the server) calls `ThreadLaunchService` and `ThreadManagementService` | Rooms, scheduler history, event-driven steering. This is how upstream's scheduler starts threads.                                                 |
| **Bearer RPC** (issue a session with narrow scopes and a short TTL, take a websocket ticket, connect) | Out-of-process Magnesium parts, such as the REST gateway and the fleet manager. Full UI parity.                                                   |
| **`/mcp` with OAuth**                                                                                 | Human-approved third-party agents only. It needs interactive approval and re-approval every 30 days, so it is a poor fit for unattended services. |

The bearer token is administrator-grade by default: issue the narrowest scopes and rotate.

### Two zones: track the server, own the web UI (D11)

There used to be a never-edit list. It existed to keep merges cheap, not because those files cannot change. It also assumed the stock T3 phone and hosted clients had to keep working. With D10 they don't, so the list is gone and the code base splits in two:

| Zone      | What                                                                                                     | Policy                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Track** | `apps/server`, `packages/contracts`, the provider packages, `packages/client-runtime`, `packages/shared` | Stay close to upstream. This is the long tail we don't want to own: adapters, orchestrator, transport and performance work, restart recovery. Our server features go in `magnesium/server`. Edit an upstream file when it is the right place; keep the change small and marked.                 |
| **Own**   | `apps/web`                                                                                               | Ours. Change what the design needs: `Sidebar.tsx` (project folders), the shell layout (footer), `ChatView.tsx` and the composer where the mocks need it. Merge upstream web changes at stable tags while that is cheap. Once a file has diverged, own it and port upstream fixes to it by hand. |

**Rules for any upstream file we change:**

- Mark each change with a `magnesium:` comment so a script can list every patched spot.
- Prefer a short hook in the upstream file, with the logic in our package.
- The weekly merge rehearsal reports conflicts per file. When a file conflicts on most merges, decide: keep merging it, or own it and port by hand.
- Hot files cost the most. `ChatView.tsx` has 309 commits in 90 days and is 12,236 lines. Changing it is allowed, and its merge cost is tracked.

**What owning the web UI costs:** much of upstream's speed work lives in web files (`ChatView.tsx`, `MessagesTimeline.tsx`, `Sidebar.tsx`; doc 06). Once we own a file, those gains have to be ported by hand. So keep new pages and components in our own files, and change the chat view only where the mocks need it.

**Still upstream by choice:**

- **Thread and run model, adapters, orchestrator, projections, checkpoints.** Rooms stay a separate aggregate (above) because that is the simpler design, not because of a rule.
- **The scheduler.** It records only the last run and a run count. We add a **run-history table** in our database, fed from thread-launch events, rather than replacing it.
- **The right panel.** Apps open on their own page (doc 13). A new tab kind is now allowed if a feature needs one.

## Upstream files we expect to change

This is a tracking list, not a cap. It covers the known edits from the plan and the mocks. The strip-and-rename commit is separate: it is generated by a script, not hand-merged.

| File                                                                             | Edit                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts`                                                      | Two hook lines: our routes layer, our workers                                                                                                        |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`, `mainAppLocation.ts`        | One nav item                                                                                                                                         |
| `apps/web/src/components/CommandPalette.tsx`                                     | One `push` of our actions                                                                                                                            |
| `apps/web/src/branding.ts`, `components/T3Wordmark.tsx` (contents), `index.html` | Branding                                                                                                                                             |
| `apps/server/src/telemetry/AnalyticsService.ts`                                  | Default **off**, key removed, plus a test                                                                                                            |
| `packages/shared/src/cliRelease.ts`                                              | Release origin                                                                                                                                       |
| `pnpm-workspace.yaml`                                                            | Add `magnesium/*`                                                                                                                                    |
| The app shell layout (`apps/web`)                                                | The footer slot (doc 13)                                                                                                                             |
| `apps/web/src/components/Sidebar.tsx` and its logic file                         | Replace the thread list with our sidebar body: project folders collapsed by default, status roll-up, standalone threads, comfy and compact (D9, D11) |
| The chat header and composer (`apps/web`)                                        | The profile avatar and sandbox chip next to the model, if the instance name is not enough                                                            |
| `apps/web` PWA files: web manifest, service worker, icons                        | Install on desktop and phone, notifications (D10)                                                                                                    |
| `apps/server/src/mcp/McpHttpServer.ts` (about line 869)                          | One line, **only** if we ever add tools on `/mcp`. Default: give profiles our own MCP entry instead.                                                 |

Server-side files stay the cheapest to keep untouched: `ws.ts`, `rpc.ts`, `Orchestrator.ts`, `ProjectionStore.ts`, the adapters and `Migrations.ts`. Change them only when a feature belongs there. Defaults and instances go in a seeded `settings.json`; paths and switches go in environment variables.

## Strip

**Posture:** do not delete cloud code. Delete whole directories, leave the rest dormant, and patch only the active hazards.

| What                                                                                   | Action                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`, `apps/desktop`, `apps/marketing`, `infra/relay`, and their CI workflows | **Delete** in one scripted commit, re-run on each merge. Whole-directory deletions merge cleanly.                                                                                                                                                                                                                          |
| Identity provider (Clerk), T3 Connect and the cloud relay                              | **Remove (D13).** They are inert when their settings are empty, so removal can be staged: web first (ours, D11), then the server side. It is wide: 143 files mention Clerk and about 436 relay files. Replace what they did: device pairing for identity, Tailscale for reach, our own web push, our own webhook endpoint. |
| Product analytics                                                                      | **Patch the default to off** and remove the key. Also set `T3CODE_TELEMETRY_ENABLED=false` in our service unit.                                                                                                                                                                                                            |
| Self-update                                                                            | Override `T3CODE_RELEASE_BASE_URL` or patch the repository constant; hide the update UI; **do not run `t3 service install`** (it pins a runtime from the release URL).                                                                                                                                                     |
| Hardcoded hosted-app and site URLs                                                     | About 15 in shipped code. Change in the scripted rename commit. `providerAuthReturnUrl.ts` is security-relevant: decide whether our origin belongs on its allowlist.                                                                                                                                                       |
| Upstream's copyright and licence                                                       | **Keep.**                                                                                                                                                                                                                                                                                                                  |

**Deleting `apps/mobile` and `apps/desktop` costs nothing we want (D10).** Magnesium's one client is its web UI, installed as a PWA on desktop and phone. The stock T3 phone, desktop and hosted clients are not supported. The desktop pill (I3) is a separate small client built on hooks the Magnesium server provides (D26).

Counts and file lists are in the seam report; the main numbers: Clerk 143 files, relay about 436, `t3.codes` links in 71.

## Rename policy

Rename only what a person sees, to **Magnesium**: the display name, wordmark, page title, CLI help text, our docs. **Keep** everything else:

| Keep                                                                                               | Why                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@t3tools/*` package scope (about 3,000 files)                                                     | Renaming conflicts with every file upstream touches. Name our packages `@magnesium/*`.                           |
| `T3CODE_*` environment variables, `~/.t3` layout, `t3` binary name, `t3.json`, `t3/` branch prefix | Breaks scripts, units, installers and existing data                                                              |
| `t3-code` MCP key and `t3_*` tool names                                                            | Provider allowlists and saved prompts reference them                                                             |
| `t3-context://` links                                                                              | **Persisted inside message text in the database**                                                                |
| All HTTP and WebSocket paths and the protocol constant                                             | Fewer merge conflicts. No outside client depends on them any more (D10), so change them when a feature needs it. |

Point `T3CODE_HOME` at our own state directory with an environment variable; that needs no edit.

## Sync policy

- **Track stable tags** (about weekly), not `main`. Merge monthly, or when a needed fix lands.
- **Weekly merge rehearsal in CI:** a read-only `git merge --no-commit` against `main`, so conflicts show as they appear, not in a three-week pile.
- **A merge script** that (1) takes upstream's lockfile and generated route tree and regenerates them, (2) re-applies the strip-and-rename commit as a script, not as a hand-merged diff, (3) runs typecheck and our tests.
- **Generic fixes** we find stay local. Upstream says it will not take them.
- **Per-file conflict report** from each rehearsal. It drives the track-or-own decision for files in `apps/web` (two zones, above).
- Keep `upstream` as a remote with pushes disabled. Keep upstream's licence file and add a NOTICE saying what the fork is. The name is Magnesium (D27) and the mark is a plain "Mg" for now. It is a GitHub fork of T3 Code named `magnesium` (D28).

## Build and deploy

- **Toolchain** (from the files, not tested): pnpm 11 through Vite+ (`vp`), Node 24, TypeScript 7 with the Effect patch step, Effect v4. Linux needs python3, make and g++ for the PTY module. The Rust resource monitor is optional.
- **Server plus web is one artifact:** `vp run --filter t3 build` builds the web app, bundles it into the server's `dist/client`, and `node apps/server/dist/bin.mjs serve` runs both. Skip desktop, mobile and marketing.
- **There is no upstream Dockerfile.** The container needs Node 24, the build output, `git` (the server shells out heavily), `openssh-client`, the provider CLIs that profiles wrap, and one volume for `T3CODE_HOME`. One port. Chromium downloads lazily (about 120 MB) for previews and HTML renders.
- **Container rules still fit.** Bind mounts only, no host namespaces, no extra ports. The conflict is only the "server launches sibling sandboxes" idea, tested in spike 1.
- **CI:** keep one trimmed workflow; delete the rest (19 files today).
- **First sign-in:** `serve` prints a pairing URL; `t3 auth session issue --token-only` mints headless tokens.

### The front door (goal 02, goal 04, D35, D38)

**Magnesium needs only two kinds of address, on any network:** the hub's URL, which your devices open, and each machine server's URL, which the hub reaches. They can be LAN addresses, tailnet names, or anything else that routes. Nothing in the product needs Tailscale. On a single box, the hub is the only server and carries no machines. The deploy runbook covers the setups (`magnesium/deploy/ansible/README.md`).

**The browser only ever talks to the hub, and pairing a device with the hub brings every machine (D38).** The hub's own server carries each machine at `/api/magnesium/env/<machine>/`, on the hub's origin (`magnesium/server/src/hub/`):

- It reads its machines from `~/.magnesium/hub-machines.json`, which the `magnesium_hub` role writes from `magnesium_hub_machines`.
- It keeps one bearer token per machine in its secret store. Browsers hold only their hub session.
- A request arrives with the hub's session cookie. The hub checks it, drops it, and sends the machine the hub's token; for `/ws` it mints a WebSocket ticket on the machine first. Pairing and admin routes stay off the proxy, and a machine's cookies never reach the hub's origin.
- The machines never dial the hub (D35).
- The hub keeps a live link to each machine (goal 04): the machine's `magnesium.server.status`, plus a heartbeat so a silent machine shows offline within about five seconds. Fleet gathers them.

**The hub reaches each machine at the URL in `hub-machines.json`,** written by the `magnesium_hub` role from entries `{name, url}`, such as `http://192.0.2.21:3773`. Only the hub needs to reach a machine's server. Lock the rest out by binding the server to an interface only the hub reaches, with a host firewall rule, or with Tailscale ACLs; the runbook shows each.

**A hub that reaches machines only through a relay** on its own loopback (a socket-activated `systemd-socket-proxyd`, say) lists them as `{name, relay_port}`, which is `http://127.0.0.1:<port>`.

**Why a path per machine, not a hostname per machine:** with separate hostnames each browser needed its own token for every machine, so every new device paired every machine again. The client changes turned out small:

- a hub environment kind that rides the hub's session cookie, like the primary;
- URL helpers that keep a base URL's path (marked edits in `packages/client-runtime`).

The hub drops its own cookies before a request reaches a machine.

**How a machine gets onto the hub:**

- A browser that paired a machine directly hands its token to the hub once (this needs an admin session on the hub). The hub's environment then replaces the saved one, and the browser's copy of the token is deleted.
- Otherwise, use Settings → Connections → Hub machines → **Give access**, with a pairing code from `magnesium-release pair` on the machine.
- Upstream bearer sessions last 30 days and can't be refreshed. Every Magnesium server has `/api/magnesium/session/renew`, and the hub renews each token in its last week.

**Adding a device:**

- **Once:** run `magnesium-release pair --admin` on the hub, and open its link on the desktop.
- **After that:** Settings → Connections → Authorized clients → **Create link** shows a QR code to scan.

## Phases (proposed; revised 2026-10-13 after the mocks)

Each phase is done when its mock boards work with real data. The per-screen breakdown, the new server modules and the new API operations are in [doc 13](13-mocks-to-working-app.md).

| Phase                          | Goal                                                                                                                                                                                                                                                                          | Done when these boards are real                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **0. Spikes and bootstrap**    | Run spikes S1 to S5. Fork at a stable tag that has the MCP-over-stdin fix (PR #17898, 2026-10-10; not in 0.0.45), or cherry-pick it. Strip script, telemetry off, branding as Magnesium, server plus web building on a Linux VM, first merge rehearsal.                       | The stock app running as Magnesium                             |
| **1. Profiles**                | Profile sync service, wrapper binary with sandbox levels, supervised permission by default, secrets by name, refusal of permission flags in launch args.                                                                                                                      | Session: the profile picker                                    |
| **2. Shell and Home**          | Places nav; our sidebar body (project folders collapsed by default, status roll-up, standalone threads, comfy and compact); the footer slot with core items; the Home feed with standalone approve and answer cards, since upstream's are bound to the composer; zoom levels. | Home · desktop; the footer's core items                        |
| **3. Rooms**                   | The room aggregate, router with rules and a decision model in shadow mode, delivery into seats, the room page (doc 12).                                                                                                                                                       | Room · desktop                                                 |
| **4. Fleet and Schedule**      | Fleet page from connections, thread summaries and a metrics adapter; jobs; launch with profile and sandbox; run history, timeline and failure inbox for scheduled tasks.                                                                                                      | Fleet · desktop; Home's fleet tiles and next runs              |
| **5. Brain and projects**      | The KB bridge; Brain overview; file tree and reader; memory edits and change requests (D22); a KB context chip; project mode, with docs in the brain tied to the project (D23).                                                                                               | Brain · desktop, Brain · document open, Project · desktop      |
| **6. Apps and the footer API** | App registry, app hosting on our route, app actions through approvals, "New app" built by an agent, app footer items.                                                                                                                                                         | Apps · desktop, Selected app · desktop, the footer's app items |
| **7. Phone polish and pill**   | The PWA on the phone: the phone layouts, install, web push for needs-you items (D10, D16). Hooks a desktop pill can use (D26). Sessions started outside Magnesium stay out (D25).                                                                                             | The five phone boards                                          |

Phases 3, 4 and 5 do not depend on each other and can run in parallel after phase 2.

## Spikes

Each is about a day for an agent. Together they decide whether the plan holds.

| #                                                   | Build                                                                                                                                                                                                                                         | Verify                                                                                                                                                                                                                                   | Answers                                                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S1. Profile instances and the wrapper**           | Build the server. Seed two Claude instances with different home dirs and a logging wrapper; repeat for Codex. Add a variant that runs the CLI in a container with `docker run -i`.                                                            | Each wrapper log shows the right config dir, args and cwd; each agent obeys its own `CLAUDE.md`; interrupts leave no orphan process; settings hot-reload; count wrapper starts during provider refresh; time container start per turn.   | Are profiles config only? Does stdio streaming survive a container? Can a sandbox reach T3's MCP endpoint, and what rewrite does it need? What does a container per turn cost? |
| **S2. A vertical slice with the merge measured**    | A `magnesium.ping` call and a stream on `/api/magnesium/ws` reusing upstream's auth; our own SQLite; a route with a sidebar item and a palette action.                                                                                        | `git diff --stat` against the tag, split by zone. Typecheck and targeted tests pass. A merge rehearsal from an older stable tag to the latest: count conflicts per file.                                                                 | Does the second route work with upstream's auth and scopes? Is the generated route tree painless? The real conflict rate on the server side.                                   |
| **S3. Create and steer a thread from outside**      | A script that issues a narrow session, gets a ticket, opens `/ws`, launches a thread on a seeded instance, subscribes, steers, interrupts and answers an approval. Repeat through `/mcp` with OAuth. Add a two-thread toy where A messages B. | The thread appears under the right project; steer lands mid-run; the same command id does not double-create; read-only tokens fail on writes; sender attribution shows.                                                                  | Which transport should Magnesium's agents API use to drive T3 (expected: bearer RPC)? Can rooms use stock sender attribution? How are headless tokens issued and rotated?      |
| **S4. The owned web shell** (added after the mocks) | Replace the sidebar's thread list with project folders, add the footer to the shell layout, host an app frame on our own route, and make `apps/web` an installable PWA with web push.                                                         | The sidebar keeps search, drag and undo. An MCP-app frame works outside a thread. The PWA installs on desktop, Android and iOS. A push reaches a locked phone. A merge rehearsal of `apps/web` over two stable tags: conflicts per file. | What owning the web UI costs per merge; whether apps can live on their own page; the push path (D16).                                                                          |
| **S5. KB bridge** (added after the mocks)           | A server-side GBrain MCP client with a read scope: search, page, backlinks, page list.                                                                                                                                                        | Latency per call; a file tree built from slugs for 1,000+ pages; nothing written.                                                                                                                                                        | Whether Brain can be built on GBrain's existing tools, and what the review queue adds.                                                                                         |

## Risks

| Risk                                                                                                                                           | Mitigation                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Merge cost.** About 50 commits a day.                                                                                                        | Keep the diff in new files; track stable tags; weekly rehearsal; a re-runnable strip script.                                                           |
| **Effect v4 fluency.** The code base and our additions depend on it.                                                                           | Budget for it. Copy upstream's patterns; keep our packages small.                                                                                      |
| **A hidden upstream seam.** Several claims here are _not verified_ (for example, whether our layers get their dependencies at the hook point). | Spike 2 exists for exactly this.                                                                                                                       |
| **Owning the web UI loses upstream's web work.** Speed and UX fixes in files we have diverged must be ported by hand.                          | New pages and components in our own files; change the chat view only where the mocks need it; the per-file conflict report decides when to own a file. |
| **Web push needs a path out of the hub's network.** Push goes through the browser vendors' push services.                                      | Payloads are encrypted end to end and kept minimal ("1 needs you"); the owner allowed it (D16).                                                        |
| **Daily-driver stability.** Version 0.0.x and moving fast.                                                                                     | Pin stable tags; keep an update runbook.                                                                                                               |
| **Telemetry and update hazards.**                                                                                                              | Patched on day one; checked in CI by a test and by an environment setting.                                                                             |
| **Name clashes.** The first name, Fuse, clashed with several products; renamed Magnesium (D27).                                                | Publish nothing under a bare `magnesium` package or command name; use a scoped one.                                                                    |
| **Sandbox bypass.** The server spawns agents as its own account on the host.                                                                   | Spike 1; run the whole server in the sandbox, or use wrappers that enter containers. Never allow full access by default.                               |
| **Secrets in two stores.** T3 keeps sensitive instance values in its own secret store.                                                         | The wrapper reads secrets by name from its own environment; keep T3's store empty of real secrets.                                                     |
| **Permissions forced by launch args.** A `--permission-mode` launch arg overrides every thread's mode.                                         | Profile sync and the profile check refuse those flags; a test covers it.                                                                               |
| **MCP token in argv on v0.0.45.** Fixed upstream in PR #17898.                                                                                 | Ported by hand in goal 01; `v0.1.0` includes it.                                                                                                       |

## Status

**Phase 0 bootstrap is built and verified (goal 01, 2026-10-14).** The fork is v0.0.45 plus a hand port of the MCP-over-stdin fix (#17898) to that tag's Claude adapter. The stock app runs as Magnesium on a desktop and on a Linux machine. What goal 01 learned that changes this plan:

- **The scripts:** `scripts/strip-upstream.ts`, `scripts/rename-upstream.ts`, `scripts/merge-upstream.ts`, `scripts/upstream-edits.ts` and `scripts/merge-rehearsal.ts` (weekly in CI). A conflict in a file only the scripts edit takes upstream's side and the scripts run again; a file that also has a hand-written `magnesium:` edit is left for a person.
- **The strip also deletes** `.github/scripts`, the release scripts that import the desktop app (`build-desktop-artifact`, `build-cli-archive`, `build-npm-platform-packages`, `smoke-cli-archive`, `release-smoke`), one server test that imports mobile code, and the patches only the deleted apps used. pnpm fails on an unused patch. The web build read the desktop manifest for licence notices; the strip drops that line.
- **The rename leaves agent-facing text alone.** Prompts, MCP tool descriptions and the checkpoint commit author keep "T3 Code", so agents behave as upstream tests them.
- **Upstream's default runtime mode is `full-access`** (`DEFAULT_RUNTIME_MODE`, used in contracts, the orchestrator and the web draft store). Goal 01 seeds `defaultRuntimeMode: "approval-required"` from `magnesium/deploy/seed/settings.json`; changing the code default is goal 03's.
- **Provider update checks poll npm and upstream's model manifest** (`raw.githubusercontent.com`) by default. The seed turns them off; flipping the contract default breaks nine upstream tests.
- **Still contacted by default:** Google's favicon service for links in chat (`packages/shared/src/favicon.ts`), and the LiteLLM price table when usage is read (`UsageService.ts`). Neither is upstream's; both are open.
- **Merge cost today:** about 30 hand-edited upstream files. A rehearsal against upstream `main` (913 commits ahead) showed 15 real conflicts. Upstream has since moved provider code into `packages/provider-*`, which the rename scope will need.

**Phase 0 deploy is built and tested (goal 02, 2026-10-14).** Magnesium runs on a hub and its agent machines, all from `magnesium/deploy/ansible`, and the browser reaches every machine through the hub (above). What goal 02 learned:

- **A server restart ends the turn in flight, not the thread.** Upstream marks the turn failed ("Provider session did not survive a server restart"), and the next message carries on in the same thread. Turns are not resumed.
- **A clean stop exits 130** (Effect's `runMain` on a signal). The unit counts 130 as success, so restarts and rollbacks don't show as failures.
- **Logs rotate already:** the server caps its trace file (10 MB × 10), and journald takes stderr. **State is backed up** by `magnesium-release backup`: daily from a user timer, and before every activate, so a rollback past a migration has a copy to restore.
- **Codex's status check can time out right after a restart** (its 10-second probe). A turn started after a reboot still worked.
- **The deploy role sets no git identity,** so a project created by a server user without one has no first commit. Agents that commit need one (goal 03's profiles).

**Spike S2 is answered (goal 04, build 1, 2026-10-15).** Our second RPC route works with upstream's auth and scopes and needs no upstream edit:

- **The route is `/api/magnesium/ws`,** not `/magnesium/ws`: under `/api`, every front door and the dev proxy already carry it, WebSocket upgrades included.
- **Scopes are part of each RPC.** Each one names the upstream scope it needs, and one middleware refuses a call without it, and any RPC that names none.
- **The host server is reached only through `ServerPorts`,** which `apps/server/src/magnesiumRoutes.ts` (our file) provides: auth, identity, threads, secrets. Goal 04's build 1 changed no upstream file.
- **`magnesium.sqlite` keeps its own migrations table,** `magnesium_migrations`.
- **Measured:** a rehearsal against upstream `main` (1,021 commits ahead) showed 21 files with real conflicts, none in a file this build touched.
- **Agents never reach the hub's machines.** The hub's routes take only sessions from paired devices. An agent's `/mcp` token is not a session at all, and a session the `t3` CLI mints is refused. An agent that can read the server's state directory could still take its secrets, so agents on the hub must be fenced off from it (goal 03).

**Phase 1, profiles and sandboxes, is built (goal 03, 2026-10-15); see above.** Upstream edits it made, each marked: the default runtime mode is `approval-required` (`packages/contracts/src/orchestration.ts`, plus one settings test); a fenced or container Codex runs without its own sandbox (`apps/server/src/provider/Layers/CodexSessionRuntime.ts`, with its own test file); a thread moving between instances that share provider state stops the old session first (`ProviderService.ts`); a fresh Codex home is set up by one app-server at a time (`CodexProvider.ts`, `CodexSessionRuntime.ts`); `t3 agents` is registered in `apps/server/src/bin.ts`; the composer and model picker show the profile avatar and sandbox chip (`apps/web`, our zone). What it learned:

- **Codex's own sandbox can't nest.** It needs bubblewrap, and neither the fence nor a container lets it start (Landlock forbids mounts; Ubuntu's bubblewrap profile forbids a nested user namespace). The live test found a supervised Codex asked twice per command: once in its failed sandbox, then to run it unsandboxed. Magnesium now turns that sandbox off under its own fence or container (D45), so it asks once.
- **Claude Code works in a fenced or container home of its own:** it writes `.claude.json` there by temp file and rename, and keeps `~/.claude.json` writes in place. Each profile obeyed its own `CLAUDE.md`.
- **The first container on a machine takes about a minute** while rootless Podman sets itself up; after that a turn starts in about 1.3 s.
- **Brain import does not yet cover profile homes** (O22).

**Spike S4's shell half is answered (goal 05, 2026-10-15).** Owning the sidebar, the footer and the PWA costs eight marked upstream files, and upstream's search, drag and undo keep working:

- **Folders are rows in upstream's flat sortable list,** not a second tree. The active rows are grouped under folder rows and two headings; the drag preview lays them out under their folders, and keyboard order skips closed folders. That takes marked edits in `Sidebar.tsx`, `Sidebar.logic.ts` and `Sidebar.drag.ts` (and its test); the folder logic, density store and status shapes are our own files in `apps/web/src/components/sidebar/`.
- **The footer** is one marked edit to `AppSidebarLayout.tsx`. **The PWA** adds marked lines to `main.tsx`, `routes/__root.tsx` and `vite.config.ts`, which were already marked; its service worker and Offline check live in `magnesium/web`.
- **Measured, stable to stable:** replaying the fork onto `v0.0.44` and merging `v0.0.45` gives 2 real conflicts (3 hunks), one in `apps/web` (`CommandPalette.tsx`). No newer stable tag exists yet.
- **Measured, against upstream's newest tag** (`v0.0.46-nightly.20261015.3171`, 1,045 commits): 26 files with real conflicts, 45 hunks; 11 in `apps/web`. Goal 05 adds one of them, `Sidebar.tsx`, with 7 hunks: upstream's nightly adds a "waiting" status, changes the row's action type and redesigns the shelf header, exactly where the board's status shapes, compact rows and shelf counts go. The two sidebar logic files and the footer's layout edit merge cleanly. Expect to re-fit those parts of the sidebar by hand when `v0.0.46` is stable.
- **The merge classifier mislabels files we add** inside a directory upstream renames (`provider/Layers/` to `provider/`): our `*.magnesium.test.ts` files there show as scripted, and `merge-upstream.ts` would take upstream's side. It should treat them as ours at the new path.
