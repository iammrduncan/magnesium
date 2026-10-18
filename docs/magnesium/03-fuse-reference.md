# The Collie-based Fuse: a reference, now replaced

**Decision (owner, 2026-10-13):** drop the Collie-based Fuse as the direction. It was an idea, not central. Keep it as a reference. Do not pin the UI on it.

**The name moved on (D8, 2026-10-13):** "Fuse" was given to the T3 Code fork (doc 11), which was then renamed **Magnesium** (D27). It replaces the Collie fork described below. In this doc, "Fuse" means the old Collie fork.

The old Fuse is a fork of Collie, an open-source self-hosted phone web app for [herdr](https://herdr.dev). It was forked on 2026-10-12 from Collie 1.20.2. Its fork plan's first phase, the rebrand, never started.

## What Fuse is

A phone PWA that mirrors herdr terminal panes. A small Bun server sits between the phone and herdr's socket. The browser never touches herdr.

## Why it does not fit the new direction

| Reason                                       | Detail                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **It is a terminal mirror.**                 | It renders pane output, and turns known dialogs into buttons through per-harness parsers. A clean transcript, diffs and structured approvals are outside that model. The owner wants to stay away from the TUI. |
| **Only Claude Code has a verified adapter.** | Other agents fall back to a raw terminal mirror (its fork plan, Phase 2).                                                                                                                                       |
| **It is a fork with a trademark condition.** | Collie's code is MIT; its name and logo are not. A fork needs its own name and mark before it is shared.                                                                                                        |
| **A fast-moving upstream.**                  | Its fork plan called for a weekly rebase. That is a standing cost.                                                                                                                                              |

## What is worth keeping as a reference

These are ideas and measured rules, not code to adopt.

| Idea                                                                                                                                              | Why it is useful for the new UI                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **"Needs you" first.** The home screen groups by what is blocked on the owner.                                                                    | This is requirement P1 almost word for word.                                                                          |
| **Status as a shape first, colour second.** Blocked is a triangle, working a half-filled circle, done a disc, idle a ring, unknown a dashed ring. | Reads on a small phone and for colour-blind eyes. Fuse measured that three status colours collapse for a deuteranope. |
| **No state may move content.** A state change repaints; it never re-lays-out. Reserve borders and word slots up front.                            | On a phone a moving layout causes a wrong tap, and a wrong tap can send a command to an agent.                        |
| **44px tap targets**, with the hit area larger than the drawn height where space is tight.                                                        | Mobile usability.                                                                                                     |
| **One notice system** with four categories (system strip, scope notice, event, contextual notice).                                                | Stops a UI growing six different alert styles.                                                                        |
| **Back goes up one level.** The history stack matches the level tree.                                                                             | Predictable phone navigation.                                                                                         |
| **A hardened front door.** Tailnet-only HTTPS, loopback bind, device pairing, tokens kept on the server.                                          | The same posture applies to any UI that can type into agents.                                                         |
| **Crews:** one front-facing lead in front of peers on other machines.                                                                             | A pattern for a multi-machine fleet view.                                                                             |
| **A states playground.** One page that renders every UI state with mock data.                                                                     | A good way to review mocks, and to catch layout shifts.                                                               |

## What T3 Code does instead

Where Fuse mirrors a pane, T3 Code keeps a structured event log per thread and renders it. See docs 05 to 08.

## Status

Retired; reference only. Nothing in this repo depends on it. Magnesium is a new fork of T3 Code (D28).
