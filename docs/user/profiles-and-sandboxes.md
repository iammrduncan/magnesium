<!-- magnesium: profiles and sandbox levels (goal 03) -->

# Profiles and sandboxes

A **profile** is an agent with its own name, rules, skills and MCP servers,
such as a reviewer or a research assistant. Pick it in the model picker for any
thread, on any machine it runs on. Every agent Magnesium starts runs inside a
**sandbox**, `fenced` by default, and you can see and change the level next to
the model.

## Sandbox levels

| Level         | What the agent can do                                                                                                                                                                                                            | Needs                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Fenced**    | Works as you, in your projects, but can't read or change Magnesium's own files (settings, secrets, the hub's access to your machines) or its installation. Projects and worktrees Magnesium keeps in its folder stay open to it. | Nothing. It uses bubblewrap where it runs, else a Linux user namespace, else Linux Landlock, or macOS. |
| **Container** | Sees only the project, its profile and its own home, in a rootless Podman container.                                                                                                                                             | Podman, and an image set by whoever installed Magnesium.                                               |
| **Native**    | No fence. Choose it only for one thread, the way you choose full access.                                                                                                                                                         | Nothing.                                                                                               |

The sandbox chip next to the model shows the thread's level. Choose it to
switch: the thread keeps its conversation, and its agent restarts at the new
level. A level this machine can't run is
greyed out, with the reason and how to enable it. **Settings → Connections →
Sandboxes** lists the levels every machine supports.

The sandbox is separate from the permission mode. New threads start in
**Supervised** mode on every level; see [Permission modes](./permission-modes.md).

Codex has a sandbox of its own, which can't start inside the fence or a
container, so Magnesium turns it off there and the fence or container takes its
place. Codex still asks before acting exactly as the permission mode says: once
per command in **Supervised**. In the auto modes, a fenced Codex can change files
outside the project, but never Magnesium's own.

Where Linux has neither bubblewrap nor user namespaces (Ubuntu blocks them for
programs without an AppArmor profile), the fence uses Landlock alone. Then a
fenced agent can't create new files directly in your home folder, or list it;
folders in it (`~/.cache`, your projects) work as usual. Install bubblewrap
(`sudo apt install bubblewrap`) to lift that. **Settings → Connections →
Sandboxes** shows which one each machine uses.

## Add a profile

Profiles live on the hub, or on your one machine if you run Magnesium on a
single box. On that machine, run:

```bash
magnesium-agents new reviewer --description "Reviews pull requests."
```

It makes `~/.magnesium/profiles/reviewer/` with two files to edit:

- **`AGENTS.md`**: who the agent is and its rules. A `CLAUDE.md` beside it is
  read too.
- **`profile.yaml`**: where it runs and how. The main settings:

  ```yaml
  machines: [build-box] # machines it goes to; "*" for all; empty for this server only
  harness: claude # or codex; harnesses: [claude, codex] offers both
  sandbox:
    level: fenced # or container
  env: [KB_TOKEN] # names of environment variables it needs, never their values
  display_name: Reviewer
  accent: "#2f80ed"
  ```

Optional: `mcp.json` for the agent's MCP servers (write `${KB_TOKEN}`, never
the token), `hooks.json`, `CONVENTIONS.md`, `MEMORIES.md`, and
`skills/<name>/SKILL.md`. To give agents your knowledge base, add its MCP
server to `mcp.json` at whatever URL you run it.

Check it, then wait. The hub sends it to its machines, and it appears in the
picker on each within a minute, with no restart:

```bash
magnesium-agents check reviewer
magnesium-agents list
```

To change a profile, edit its files. To remove it, delete its folder; each
machine keeps the agent's past sessions.

Environment variables a profile names come from the Magnesium service's
environment on each machine. Put secrets in an env file only the service can
read, never in the profile.

## What a profile can't do

Magnesium refuses a profile that would weaken your control, and says why:

- `--dangerously-skip-permissions`, `--permission-mode` and similar flags in
  `launch_args`: full access is chosen per thread, never by a profile;
- `native` as its sandbox level;
- a secret written into `mcp.json` or `hooks.json`;
- a container image that isn't pinned by digest.

The other profiles keep working. `magnesium-agents check` lists every problem.
