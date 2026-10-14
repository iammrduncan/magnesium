<!-- magnesium: Magnesium's own README. On a merge conflict, keep ours; scripts/merge-upstream.ts does. -->

# Magnesium

**Magnesium is one place to run and watch coding agents across a small fleet of machines.** It is a web UI, installed as an app on desktop and phone, backed by a Magnesium server on each machine that runs agents and a hub that gathers them together.

It is built for one person: the owner, who drives several agents and bots all day and wants to see at a glance what needs them.

The name comes from the magnesium ribbon that lights thermite. The mark is a plain **Mg**.

Talk about Magnesium in the [Hackers in the Loop Discord](https://discord.gg/3Qs2uejUf9).

## What it is for

The target, from the owner's mocks and build plan:

- **Home: what needs you.** Every approval, question, plan and failure from every machine in one feed, answered in place, and pushed to a locked phone.
- **Rooms.** You and several bots in one conversation, with explicit routing, hop caps and a Stop button. A small model decides who an unaddressed message is for.
- **Fleet.** Live load and GPUs per machine, what runs where, and launching work anywhere.
- **Brain.** The knowledge base: ask it, browse it, read a page, start a thread about it, and edit the memories agents keep.
- **Profiles and sandboxes.** Pick a profile (an agent identity with its own memory and settings) and a sandbox for any thread, on any machine. Threads start supervised; full access is never a default.
- **Projects, schedules and apps.** Project docs linked to their threads, scheduled runs with history, and small apps that add pages and footer items.
- **Any harness.** Claude Code and Codex today; OpenCode, Pi and others through profiles.

## Status

Early. The build plan is 22 goals in [`docs/magnesium/goals/`](docs/magnesium/goals/README.md), each ending in something testable by hand.

**Goal 01 is done.** The working base runs as Magnesium:

- Claude Code and Codex threads work, with supervised approvals.
- Pairing is the only sign-in.
- Telemetry and self-update are off.
- It runs on a desktop and on Linux agent machines.

Everything in the list above that goes beyond running threads is still to come.

## How it relates to T3 Code

Magnesium starts from [T3 Code](https://github.com/pingdotgg/t3code), and keeps its server: the provider adapters, the orchestrator, the transport and checkpoints. Magnesium tracks it at stable tags.

The rest diverges:

- **One client.** Magnesium's own web UI, installed as an app on desktop and phone. T3 Code's desktop, mobile and hosted apps are removed.
- **Nothing hosted.** T3 Connect, the hosted sign-in and product analytics are gone. Pairing is the sign-in, and the tailnet is the reach.
- **New features in new packages.** Magnesium's code goes in `magnesium/*`, and every edit to a T3 Code file is marked `magnesium:`, so merges stay measurable.

Magnesium is not made, endorsed or supported by T3 Tools Inc. See [NOTICE](NOTICE).

## Run it

No releases are published. Build from source:

1. Install Node 24 and [Vite+](https://viteplus.dev/guide/) (`vp`).
2. Log in to at least one provider: `claude auth login` or `codex login`.
3. Install and build:

   ```bash
   vp i
   vp run --filter t3 build
   ```

4. Copy the seed settings, which start threads supervised:

   ```bash
   mkdir -p ~/.magnesium/userdata
   cp magnesium/deploy/seed/settings.json ~/.magnesium/userdata/settings.json
   ```

5. Start the server:

   ```bash
   T3CODE_HOME=~/.magnesium node apps/server/dist/bin.mjs serve --host <address>
   ```

   It prints a pairing URL that works for 5 minutes. Open it in a browser.

To pair another browser later, run `node apps/server/dist/bin.mjs pair` with the same `T3CODE_HOME`.

A few things to know:

- Keep Magnesium's state apart from any T3 Code install in `~/.t3`.
- Don't use `t3 service install`; [`magnesium/deploy`](magnesium/deploy/README.md) has a systemd user unit instead.
- The binary, the `T3CODE_*` variables and the `~/.t3` layout keep T3 Code's names on purpose, so merges and existing data keep working.

## The repo

| Path                                                  | What it is                                              |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `apps/server`, `packages/*`                           | The server and shared packages, tracked from T3 Code    |
| `apps/web`                                            | The web UI, Magnesium's own                             |
| `magnesium/*`                                         | Magnesium's packages: contracts, server, web and deploy |
| `docs/magnesium/`                                     | Research, decisions and the build goals                 |
| `scripts/*-upstream.ts`, `scripts/merge-rehearsal.ts` | Strip, rename, merge and measure against T3 Code        |
| [`MAGNESIUM.md`](MAGNESIUM.md)                        | Instructions for agents working here                    |

## Licence

MIT. The licence and T3 Tools Inc.'s copyright stay as they came in [LICENSE](LICENSE).
