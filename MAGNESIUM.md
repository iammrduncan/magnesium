# Magnesium

**Magnesium is the owner's fork of T3 Code.** It is one web UI, installed as a PWA on desktop and phone. From it the owner drives agents across a small fleet of machines: a Home feed of what needs them, rooms where several bots talk, a fleet view, the knowledge base ("Brain"), projects and small apps. It is for one person (D14). The name comes from the magnesium ribbon that lights thermite (D27), and the mark is a plain "Mg".

This file is for agents working in this repo. **Where it disagrees with upstream's `AGENTS.md`, this file wins.** The rest of `AGENTS.md` still applies: the three ways to hurt yourself, dev servers, test data, verifying, how it works, and taste.

## Start here

- **What's next and where each goal stands:** [`TRACKER.md`](TRACKER.md), the one tracker.
- **To work on a goal:**
  1. Open its file in [`docs/magnesium/goals/`](docs/magnesium/goals/).
  2. Read the goals [README](docs/magnesium/goals/README.md): "Done means" and "Rules for every goal".
  3. Read the docs the goal links to.
- **For the why:** [decisions](docs/magnesium/09-decisions-and-open-questions.md) (D1 onward), the [fork plan](docs/magnesium/11-fork-plan.md), and [mocks to a working app](docs/magnesium/13-mocks-to-working-app.md). The index is [`docs/magnesium/README.md`](docs/magnesium/README.md).
- **The UX target** is the owner's mock canvas (D9). Every board is rendered, with notes, in [`docs/magnesium/mockups.md`](docs/magnesium/mockups.md). Compare your screens with those boards. The canvas itself is in the repo, [`docs/magnesium/mockups/canvas/`](docs/magnesium/mockups/canvas/): `vp run mocks` serves it to click through, and a goal that adds a board adds it there.

## Where upstream's AGENTS.md doesn't apply

| Upstream says                                             | In Magnesium                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "We, us and maintainers" are T3 Code's maintainers        | **The owner directs this fork.** Upstream doesn't take outside changes, so nothing here goes upstream.                                                                                                                         |
| Three surfaces: web (with app.t3.codes), desktop, mobile  | **One surface: our web UI as a PWA,** at desktop and phone widths (D10). The strip script deletes `apps/desktop`, `apps/mobile`, `apps/marketing` and `infra/relay`. Ignore guidance for them, and the `test-t3-mobile` skill. |
| T3 Connect is core                                        | **T3 Connect, Clerk sign-in and product analytics are being removed** (D13). Pairing is the sign-in, any network that reaches the hub (a LAN, a tailnet or a VPN) is the reach, and the hub is the one front door.             |
| "Hit every surface" lists web, desktop and mobile clients | Web only. The rest of that list still applies: entry points, providers, agents, contracts, reverse states, connection modes and docs.                                                                                          |
| Don't commit plans or research notes                      | **`docs/magnesium/` is committed on purpose** (D29): research, decisions and goals, about the product. Keep it current. Scratch work and notes about the owner's own lab go in the gitignored `.internal/` folder.             |
| Don't run repo-wide checks                                | Use targeted checks while you work. **To finish a goal,** the full typecheck and test suite must pass once, locally or in our CI.                                                                                              |
| Don't use browsers or computer use unless asked           | Goals end with screens compared against their mock boards. Ask the owner once per goal before using a browser or computer use for that.                                                                                        |
| PRs to upstream's rules                                   | Same style (conventional titles, plain language). PRs go to this fork only, and only when the owner asks.                                                                                                                      |

## Fork discipline (D11, doc 11)

- **Two zones.**
  - **Track** the server side closely: `apps/server`, `packages/contracts`, `packages/shared`, `packages/client-runtime` and the provider packages.
  - **Own** `apps/web`.
- **New code goes in our packages:** `magnesium/contracts`, `magnesium/server`, `magnesium/web` and `magnesium/deploy`, scoped `@magnesium/*`.
- **Mark every edit to an upstream file** with a `magnesium:` comment (in Markdown, `<!-- magnesium: … -->`), so a script can list each one.
- **Rename only what a person sees** (doc 11's rename policy). Keep `@t3tools/*`, `T3CODE_*`, the `~/.t3` layout, the `t3` binary, and the HTTP and WebSocket paths.
- **Strip and rename are scripts,** re-run after every merge from upstream: `scripts/strip-upstream.ts` and `scripts/rename-upstream.ts`. Merge with `scripts/merge-upstream.ts`, and list the marked edits with `scripts/upstream-edits.ts --check`.
- **`upstream` is fetch-only.** Never push to it, and never open PRs there.
- **Track upstream's stable tags.** A weekly merge rehearsal (`scripts/merge-rehearsal.ts`) reports conflicts per file.
- **Log every upstream merge, pick, port or skip** in [`upstream-changelog.md`](upstream-changelog.md), in the same commit (see `AGENTS.md`).

## Rules

- **This repo is public, and Magnesium is a product others install.** Docs, goals and commit messages describe the product: what it does and how anyone installs, configures and tests it. Commit nothing about the owner's own lab or deployments (hosts, addresses, network paths, ports opened where, workload names, deploy logs), no people's names or private paths, no secrets and no knowledge-base content. Lab-specific notes live in the gitignored `.internal/` folder, never in public files. Before every commit, run `vp run check:public` (it reads what you staged, against the private denylist in `.internal/`) and read `git diff --cached`.
- **Secrets pass by name only.** They never go in settings, profiles, app manifests, argv or logs.
- **Supervised by default.** Full access is never a default. Headless and scheduled runs are never weaker than the `container` sandbox.
- **Never run a server against a real T3 home** (`~/.t3`) on the owner's machines. Use the worktree's `.t3` or a scratch `T3CODE_HOME`.
- **Magnesium starts no GPU work of its own.** It reads GPU metrics. Agents attached inside a workload (D59) work with what that workload has, its GPUs included.
- **Telemetry stays off,** and self-update never points at upstream.
- **Owner gates** are listed in the goals README and in each goal. Stop and ask at each one.

## The earlier toolkit and the Brain (D37, D56)

Magnesium replaces an earlier private toolkit, dBrain (D37); where older docs or commits say dBrain, read "build it in Magnesium".

The Magnesium Brain is Magnesium's own knowledge base, a GBrain engine Magnesium runs and controls (D56, goal 29). An existing GBrain is only a source to import from; don't build on it.

## Reporting a goal

At the end of a goal, and also when it stops early:

- Set its status in [`TRACKER.md`](TRACKER.md) (`In progress`, `Verified`, or `Blocked` with the reason), and write its dated **Goal summary** and **Next steps** in the goal file. Write them about the product: what works and which tests passed, never the owner's lab or deployments (those notes go in `.internal/`).
- Put both in your final reply.
- Update the screen status in doc 13, and the decisions and open questions in doc 09, when they change.
- Move a `Verified` goal to `docs/magnesium/goals/_completed/`.

## Git

- Commit as you go while working a goal, with conventional titles such as `feat(web): project folders in the sidebar`. End each message with the co-author line your harness asks for.
- Push only when the goal or the owner says so, and only to `origin`.
