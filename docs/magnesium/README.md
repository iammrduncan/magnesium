# Magnesium docs

Research, decisions and the build plan behind Magnesium, the harness UI: what we need, what exists, what T3 Code does well, what we decide, and the goals that build it. Start with [the goals](goals/README.md) to build; read docs 09, 11 and 13 for the why.

These docs moved here from dBrain on 2026-10-14 (D29). The fork's agent instructions are in [`MAGNESIUM.md`](../../MAGNESIUM.md).

**Result so far (2026-10-13):** the visual and interaction base is **T3 Code**, and we will **fork it** and extend it as **Magnesium** ([doc 11](11-fork-plan.md)). The UI is not a terminal mirror. The earlier Collie-based Fuse is retired and kept as a reference only. Group chat will use MCP events with a decision model in front ([doc 12](12-channel-chat-and-events.md)).

## How to read this

| Doc                                                                            | What it answers                                                                                                                                                     | Status                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [01-requirements.md](01-requirements.md)                                       | The requirements, numbered, with what exists for each                                                                                                               | Written                                    |
| [03-fuse-reference.md](03-fuse-reference.md)                                   | What the Collie-based Fuse taught us, and what we keep (the name went to the T3 Code fork first, which is now Magnesium)                                            | Written                                    |
| [05-t3code-overview.md](05-t3code-overview.md)                                 | What T3 Code is and how it is built                                                                                                                                 | Written                                    |
| [06-t3code-performance.md](06-t3code-performance.md)                           | Why it feels fast                                                                                                                                                   | Written (read from source, not run)        |
| [07-t3code-ux.md](07-t3code-ux.md)                                             | Its object model, layout and visual language, with token values                                                                                                     | Written (read from source, not run)        |
| [08-t3code-providers-and-remote.md](08-t3code-providers-and-remote.md)         | How it drives each harness, its remote model, and the build options                                                                                                 | Written (read from source, not run)        |
| [09-decisions-and-open-questions.md](09-decisions-and-open-questions.md)       | Decisions taken, and what is still open                                                                                                                             | Written, updated as we go                  |
| [10-mock-ideas.md](10-mock-ideas.md)                                           | Ideas for the UI mocks, from the research, and what was mocked                                                                                                      | Mocked (16 boards)                         |
| [11-fork-plan.md](11-fork-plan.md)                                             | How we fork T3 Code: architecture, two zones (track the server, own the web UI), strip, rename, sync, phases, spikes                                                | Phase 0 built (goal 01); the rest proposed |
| [12-channel-chat-and-events.md](12-channel-chat-and-events.md)                 | Group and channel chat on MCP events with a decision model in front                                                                                                 | Designed                                   |
| [13-mocks-to-working-app.md](13-mocks-to-working-app.md)                       | What it takes to make each mocked screen real: what T3 gives, what we build, server modules, API operations, revised phases, new spikes                             | Plan                                       |
| [mockups.md](mockups.md)                                                       | The 16 mock boards as images, with what each shows, the goals that build it, and what changed since it was drawn                                                    | Rendered 2026-10-14                        |
| [14-apps-and-footer-extension-model.md](14-apps-and-footer-extension-model.md) | How apps and footer items extend Magnesium: Hermes Desktop and DeepSeek Harness compared, and a proposed manifest, isolation and approval flow; plus the name check | Proposal                                   |
| [15-magnesium-as-a-product.md](15-magnesium-as-a-product.md)                   | What Magnesium needs from any lab (four interfaces), and who owns what between the product and a lab's infrastructure                                               | Decided (D57, D59)                         |
| [goals/](goals/README.md)                                                      | The build plan as goal files, each ending in something the owner can test, from the fork to daily use on the hub and four agent machines                            | Goal 01 verified; the rest planned         |

## Source of truth

The owner's requirements are in `requirements.txt` at the root of the dBrain repo. **Do not edit that file.** [`requirements.txt`](requirements.txt) here is a copy taken on 2026-10-14; if the two differ, dBrain's wins, and the copy is refreshed. Doc 01 restates it with numbers so other docs can point at a line item.

## Evidence rules

- Each claim says where it came from: a file and line, a doc, or "owner decision, date".
- **Read** means we opened the source. **Inferred** means we reasoned from names or structure and did not check. **Not verified** means nobody ran it.
- T3 Code facts come from a read-only clone taken on 2026-10-13 (commit `380bba36`). T3 Code moves fast, so re-check before relying on a detail.
- **Paths:** a path in backticks with no repo named is in the **dBrain** repo, the owner's earlier harness. Docs 05 to 08 cite **T3 Code** paths, as of the commit above. Paths under `magnesium/` (our packages) and `docs/magnesium/` are in this repo.
- **This repo is public, and these docs describe the product.** They name no hosts, addresses, people, organisations or private paths, hold no knowledge-base content, and say nothing about the owner's own lab or deployments: those notes live in the gitignored `.internal/` folder.
