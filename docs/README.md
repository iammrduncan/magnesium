# Magnesium docs

<!-- magnesium: Magnesium's index (D10, D13). It adds Magnesium's guides, and leaves out the pages for parts Magnesium removes or turns off: the desktop and mobile apps, T3 Connect and its relay, product analytics, `t3 service` and self-update, and upstream's release. Those pages stay in the tree so merges stay cheap. -->

## Using Magnesium

- [Install Magnesium](../README.md#install) <!-- magnesium: replaces T3 Code's install page -->
- [The hub: every machine on every device](./user/hub.md) <!-- magnesium: D38 -->
- [Profiles and sandboxes](./user/profiles-and-sandboxes.md) <!-- magnesium: goal 03 -->
- [Machines in Kubernetes](./user/kubernetes.md) <!-- magnesium: goal 25 -->
- [Deploy runbook: machines, updates, rollback and backups](../magnesium/deploy/ansible/README.md) <!-- magnesium: goal 02 -->
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Visual replies](./user/html-renders.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Remote access](./user/remote-access.md)
- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)
- [Outside agents (MCP)](./user/outside-agents.md)
- Provider guides: [Setup](./user/install.md#providers) · [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md) · [Pi](./user/providers-pi.md) · [Muse Code](./user/providers-muse.md) <!-- magnesium: Setup links T3 Code's provider setup -->

---

## Working on Magnesium

Start with [MAGNESIUM.md](../MAGNESIUM.md) (the fork's rules), the [development runbook](./operations/development.md), and Magnesium's [research, decisions and goals](./magnesium/README.md). <!-- magnesium: Magnesium doesn't use T3 Code's contribution policy -->

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Adding a provider](./internals/adding-a-provider.md)
- [Pull request file revisions](./internals/pull-request-file-revisions.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Observability](./operations/observability.md)
