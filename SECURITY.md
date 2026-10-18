<!-- magnesium: Magnesium's own security policy. T3 Code's is in .github/SECURITY.md and covers T3 Code only. -->

# Security

Magnesium is single-user software. One person runs it on their own machines, every device they pair acts as them, and its agents work in their projects with their provider sign-ins. A paired device or an agent doing what it was allowed to do is not a vulnerability; a way around those limits is.

## Reporting a vulnerability

Don't open a public issue, pull request or Discord message with the details. Issues and GitHub's private vulnerability reporting are both off for this repo, so:

1. Write to the maintainer in the [Hackers in the Loop Discord](https://discord.gg/3Qs2uejUf9). Say only that you have a security report for Magnesium, and ask for a private channel.
2. Send the details there: what an attacker needs, what they get, and the steps to reproduce it on a current `main`.

Only the latest `main` is supported; there are no releases yet. Please give the fix time to land before you publish.

## In scope

- **Pairing and sessions:** pairing links and codes, devices with and without **Manage access**, revoking a device, and the sessions a pairing creates.
- **The hub's proxy to machines:** the routes that carry each machine, and the access grants the hub holds and renews. A device that wasn't paired with the hub, an agent, or a command-line session should never reach a machine through it.
- **The Kubernetes gateway:** reaching a machine behind it without the hub's access.
- **The fence and the container sandbox:** an agent that reads or changes Magnesium's state, its install or the hub's access; a profile that gets full access or the `native` level past `magnesium-agents check`.
- **Secrets:** a secret that reaches settings, profiles, process arguments or logs.

## Out of scope

- What an agent does inside its sandbox with the permission mode you chose.
- A machine whose port is open to more than the hub, or a hub served over plain HTTP on a network you don't trust. The [deploy runbook](magnesium/deploy/ansible/README.md) says how to close both.
- Claude Code, Codex, OpenCode and other provider CLIs: report those to their makers.
- T3 Code code that Magnesium hasn't changed: report it to T3 Code as [its policy](.github/SECURITY.md) says, and tell us too.
