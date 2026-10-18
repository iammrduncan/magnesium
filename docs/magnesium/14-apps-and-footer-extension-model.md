# Apps and the footer: the extension model

**Status: research and a proposal (2026-10-13), extended 2026-10-16.** It answers O25 and follows D24: an app's views and tools live on the hub, and the extension model copies how Hermes Desktop and DeepSeek Harness make themselves extendable. Read from source and docs; nothing was run. On 2026-10-16 the owner added three things: a design system that apps and agents build with (D54, goal 27), a builder that is a thread on the hub on any harness (D55, goal 17), and apps with parts that run on machines (D55, goal 28). "Plugin" and "app" mean the same thing here.

**Result:**

- **Copy Hermes Desktop's registry and its status-bar item.** Every surface, the core app's included, registers into named areas. A footer item is a short label, a tooltip and a popover.
- **Copy DeepSeek Harness's approvals and installs.** Every approval ends in one of a closed set of outcomes and fails closed. Installs go through a tool that asks first.
- **One difference from both: each app's UI runs in a sandboxed frame.** It talks to Magnesium over the MCP Apps bridge, which T3 Code already hosts. Neither Hermes nor DeepSeek Harness isolates plugin code. Hermes's own docs say a plugin source that is not local "will need a real boundary (iframe/worker + CSP + capability gating)". Agent-built apps served from the hub to a phone are that case. **This difference is for the owner to confirm.**

## Sources

- Hermes Agent and Hermes Desktop: `NousResearch/hermes-agent` at tag `rc.4-v0.21.7` (2026-10-08), and its [desktop plugin SDK guide](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).
- DeepSeek Harness: `deepseek-ai/deepseek-harness` (MIT; npm `@deepseek-ai/dsh`, first published 2026-08-10, now a 0.2 developer preview). "DeepSeek harness" in D24 is taken to mean this; the other candidate, a community DeepSeek TUI, has blog posts and forks only.
- For comparison: Claude Code plugins, the MCP Apps spec (2026-01-26), the OpenAI Apps SDK, VS Code, Raycast, Obsidian, and T3 Code's MCP apps and HTML replies.

## How the two models work

|                        | Hermes Desktop                                                                                                                                                                                                                           | DeepSeek Harness                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plugin**             | One ESM file, `desktop-plugins/<id>/plugin.js`, exporting `{ id, register(ctx) }`; an agent half in `plugin.yaml` with tools, capabilities and a config schema                                                                           | An npm package; `package.json` declares a bundle and an optional browser half                                                                                                      |
| **UI**                 | One registry of named areas: routes, sidebar nav, status bar left and right, palette, panes, title bar, themes, and inline transcript directives. Ids are namespaced `<plugin>:<id>`.                                                    | Typed slots (`single`, `list`, `keyed`, `chain`) scoped to the app or a session. No status bar.                                                                                    |
| **Footer item**        | `StatusbarItem`: `label`, `detail` tooltip, `order`, a popover (`menuContent`) or a list (`menuItems`), and `toggleLabel` so the user can hide it                                                                                        | None                                                                                                                                                                               |
| **Isolation**          | None: plugins run with full app authority; error boundaries only. Outside web content goes in an opaque-origin `SandboxedFrame`.                                                                                                         | None: plugin code runs in-process                                                                                                                                                  |
| **Approvals**          | Desktop plugins have no permission model. On the agent side, a `pre_tool_call` hook can send a call to the human gate; an MCP server marked untrusted asks before every tool not marked read-only and fails closed when no one is there. | `approval.request()` returns `allowed-once`, `rejected`, `cancelled` or `unavailable`; callers fail closed on anything but `allowed-once`; each ask and answer is logged as a pair |
| **Install and reload** | The plugin folder is watched and hot-reloads on save; packages are staged, then renamed into place, and start disabled; `validate` and `doctor` commands                                                                                 | Installed per profile through pnpm, SHA pinning advised, a version-range check with explicit exemptions; live reload reports `applied` or `restart-required`                       |
| **For agents**         | A bundled skill with a plugin template; no build step                                                                                                                                                                                    | In Creator mode the agent installs with a `plugin_manager` tool that asks on every call, and finds live slots with inspection tools                                                |

T3 Code today: MCP apps and HTML replies render in frames that never get the app's own origin (`allow-scripts allow-forms`), with the theme passed as CSS variables. It asks before any tool not marked read-only and before every message. It works only inside a thread.

## The proposal for Magnesium

### Manifest

One folder per app on the hub: `apps/<id>/app.json`, a `ui/` folder, an optional `server/` that runs on the hub, and an optional `machine/` that runs on chosen machine servers (below).

```json
{
  "id": "gpu-board",
  "name": "GPU Board",
  "version": "1.3.0",
  "magnesiumApi": ">=1 <2",
  "defaultEnabled": false,
  "author": { "profile": "<builder>", "thread": "<thread-id>" },
  "contributes": {
    "page": { "entry": "ui/index.html" },
    "footer": [
      {
        "id": "load",
        "side": "right",
        "order": 80,
        "toggleLabel": "GPU load",
        "source": { "tool": "gpu_summary", "every": "15s" },
        "popover": { "entry": "ui/popover.html" }
      }
    ],
    "homeCards": [{ "id": "busy", "source": { "tool": "gpu_summary" } }]
  },
  "tools": [
    { "name": "gpu_summary", "readOnly": true },
    { "name": "drain_gpu", "approval": "Drain {{gpu}} on {{machine}}" }
  ],
  "server": { "command": "node", "args": ["server/index.js"], "sandbox": "container" },
  "machine": {
    "command": "node",
    "args": ["machine/index.js"],
    "sandbox": "fenced",
    "on": { "tags": ["gpu"] },
    "tools": [{ "name": "gpu_status", "readOnly": true, "forSessions": true }],
    "stats": [{ "id": "gpu", "every": "15s" }]
  },
  "data": { "read": ["fleet.machines"] },
  "csp": { "connectDomains": [] }
}
```

### Contribution points

One registry, as in Hermes: namespaced ids, an error boundary per item, and Magnesium's own core items registered the same way.

- **Page:** a route under Apps, which the user can pin to the sidebar.
- **Footer item:** a list slot with Hermes's `StatusbarItem` shape: label, tooltip, tone, badge and a hide toggle.
  - **The label is data, not code.** The hub fills it from a read-only tool on a timer, or from an app event, and sends it on the `footer.items` stream.
  - **The popover is a small app view.** It loads only when opened, and becomes a bottom sheet on the phone.
- **Home card:** declarative (title, value, tone, link), filled from a read-only tool.

### Isolation

- **Every app view runs in a sandboxed frame** on its own origin and speaks the MCP Apps bridge: `tools/call`, `ui/message` and model-context updates. Theme tokens arrive as host-context changes. This reuses T3's MCP-app frame and its theme injection.
- **The frame's CSP blocks all network.** Data comes only through `tools/call`, which the hub proxies. App files never hold tokens.

### Approvals

1. **On enable, the user consents once** to the app's tools, data reads and network domains. A new version that widens any of them asks again, for the difference only.
2. **Tools marked `readOnly` run without asking.**
3. **Every other call goes to the hub's approval queue,** whether it comes from a page, a popover button or an agent. The queue shows on Home and is pushed to the phone. Each request shows the app, its version, the author profile and the rendered `approval` text.
4. **Outcomes are DeepSeek Harness's closed set.** Anything but `allowed-once` fails, including a request nobody answers.
5. **A message from an app into a thread always asks first,** as in T3.
6. **App servers run at the `container` sandbox level or stricter,** as `MAGNESIUM.md` requires of every headless run.
7. **Turning an app off removes its page, footer item, card and tools together.**

### The design system (D54)

App views are built with Magnesium's design system (goal 27): T3 Code's look plus Magnesium's own pieces, as tokens, a CSS layer for plain HTML, a React kit and written rules, with a `magnesium-design` skill for agents. The kit is bundled into each app when it is published, since a frame has no network. Theme changes reach an open app as host-context updates, so it follows light, dark and the user's theme. Apps may add their own components and styles; the validator only warns about raw colors, fonts and restyled kit pieces.

### Machine parts (D55)

An app may also carry a **machine part**, which runs on the machine servers the user picks, and an app with both halves is a **dual app**. A machine part adds to its machine: stats that Fleet and its hub part read, and tools offered to later agent sessions there (for profiles that opt in). The hub delivers each version over the Fleet link, as profile sync does; the machine checks it and runs it fenced or in a container, never with access to the server's state home. Its tools follow the same rules as an app's: read-only ones run, the rest ask first on Home. Consent is asked per machine. Views still live only on the hub.

### How an agent builds and ships an app

1. "New app" starts a **builder thread** on the hub (D55), on whichever harness and model the user picks, with the contract, the design system's skill and kit, templates (a hub app, a machine part, a dual app) and a pinned bridge script loaded as context.
2. The agent writes to `apps-drafts/<id>/`, and the hub hot-reloads a preview of the draft beside the thread. A draft machine part runs on a test machine, after asking first. When the work spans machines, the builder launches and steers agents there through agent control (goal 18).
3. The builder has these hub tools: `apps.validate` (manifest, CSP, no secrets, the design system's rules), `apps.inspect` (the live areas and what is in them), `apps.preview` (screenshots through T3's headless browser), `apps.tryOnMachine` (asks first) and `apps.publish`, which asks first.
4. **Publishing** stages the files and renames them into `apps/<id>/` as a new git-tracked version, recording the author profile and thread. The new version starts disabled; rollback is picking an earlier version. An app whose `magnesiumApi` range does not match is refused unless the owner grants an exemption.

### What comes from where

- **From Hermes Desktop:**
  - the registry and its named areas;
  - the footer item with its popover and hide toggle;
  - namespaced ids, disposers and opt-in enabling;
  - one folder per app, with hot reload;
  - validate and doctor tools;
  - an agent skill with a template;
  - asking before tools not marked read-only.
- **From DeepSeek Harness:**
  - typed list slots;
  - closed, audited approval outcomes;
  - installs through a manager tool that asks first;
  - an inspection tool;
  - version ranges with exemptions.
- **From neither:** running app code inside Magnesium itself. Both projects say plainly that this is not a security boundary.

## The name (O8, closed by D27)

"Fuse" clashed with several products. FuseBase was the closest: an AI app builder with agents. The others were Fuse.js, FUSE/libfuse, a Firecracker sandbox project with a `fused` agent, Fuse AI, Siemens' Fuse EDA agent and Fuse Open; Langfuse is a near-name.

**The app is now Magnesium** (D27), after the magnesium ribbon that lights thermite. A check on 2026-10-13 found no AI or developer product named Magnesium; the nearest names are Magick and Magma, both agent tools. npm's `magnesium` is a small unrelated package, so publish under a scoped name.

## Not verified

- Whether T3's MCP-app frame works outside a thread, and whether its opaque-origin frame meets the MCP Apps rule for web hosts (spike S4).
- OpenAI's move to MCP Apps keys (secondary sources only).
- The VS Code and MCP-UI comparisons (from prior knowledge, not re-read).
- Hermes and DeepSeek Harness were read, not run.
