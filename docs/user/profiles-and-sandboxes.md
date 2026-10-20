<!-- magnesium: profiles and sandbox levels (goals 03 and 34) -->

# Profiles and sandboxes

A **profile** is an agent with its own name, rules, skills and MCP servers,
such as a reviewer or a research assistant. Pick it in the model picker for any
thread, on any machine it runs on. Every agent Magnesium starts runs inside a
**sandbox**, `fenced` by default, and you can see and change the level next to
the model.

## Sandbox levels

| Level         | What the agent can do                                                                                                                                                                                                                                                      | Needs                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Fenced**    | Works as you, in your projects, but can't read or change Magnesium's own files (settings, secrets, the hub's access to your machines) or its installation. Projects and worktrees Magnesium keeps in its folder stay open to it; it won't start in any other folder there. | Nothing. It uses bubblewrap where it runs, else a Linux user namespace, else Linux Landlock, or macOS. |
| **Container** | Sees only the project, its profile and its own home, in a rootless Podman container.                                                                                                                                                                                       | Podman, and an image set by whoever installed Magnesium.                                               |
| **Native**    | No fence. Choose it only for one thread, the way you choose full access.                                                                                                                                                                                                   | Nothing.                                                                                               |

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

## Make a profile

Profiles live on the hub, or on your one machine if you run Magnesium on a
single box. **Profiles** in the sidebar lists them all: how many there are,
which ones an agent asks you to change, and for each its version and whether
every machine holds it. Choose **+**, or **Create a profile** in the model
picker while you have none. Give it a name (it can't change later, because its
threads are tied to it) and a line about what it does. A new profile runs on
every machine, on Claude Code, fenced.

Open a profile to change it. Each tab changes one part of it, and every save
is checked first:

- **Instructions**: who the agent is and its rules, in `AGENTS.md`, with
  `CLAUDE.md` and any other Markdown file you add beside it.
- **Skills**: one folder each, with its `SKILL.md`.
- **Tools**: the agent's MCP servers, and for each server whether its tools
  run without asking, ask first, or are off, one tool at a time. These hold
  in every permission mode: a tool that is off isn't offered even in Full
  access. A server that needs a secret takes the variable's name, never its
  value. Claude Code
  can't turn off the rest of a server's tools while some stay on; the page
  says so where that matters.
- **Environment**: the variables it needs, by name, and which machines have
  each one. Values never leave the machine.
- **Runs on**: every machine, or the ones you tick; its harnesses (Claude
  Code, Codex or OpenCode) and sandbox level. OpenCode runs fenced or native,
  and uses the machine's own OpenCode setup for its models. Profiles need
  OpenCode 2.x: a machine with 1.x runs none on OpenCode. Set
  `MAGNESIUM_OPENCODE_BIN` to pick which OpenCode a machine uses.
- **History**: every version, by you or by an agent you approved, with what it
  changed. **Put back** restores an earlier one.

**Delivery**, beside the tabs, shows what each machine holds: the version and when
it was checked, whether it refused the profile and why, or that it isn't
connected. **Send now** delivers at once; otherwise a change reaches its
machines within a minute, with no restart.

**Delete** names the threads on the profile; they keep their history and can
move to another profile. A deleted profile can be restored, with its history,
for 30 days.

**Used by**, under it, lists the threads that run on the profile, and **New
thread** starts one without a project, on the hub when the profile runs there,
or else on a machine that holds it. In a thread, the model picker's **Edit
profile** opens the profile the thread runs.

## Talk to a profile

Each profile that runs on the hub is also listed under the sidebar's places,
like a bot. Click it to open your conversation with it: one long-running
thread on the hub, which you come back to each time. **New conversation**
(the pencil beside its name, or the command palette) archives that one and
starts another; past conversations stay among your archived threads. A
profile that doesn't run on the hub isn't listed there; tick the hub, or
every machine, on its **Runs on** tab.

## Agents change profiles too

Agents have Magnesium's profile tools in every thread: `list_profiles`,
`get_profile` and `check_profiles` read; `create_profile`, `update_profile` and
`delete_profile` ask you first. An ask is a **Profile change** card on Home,
and on the profile's page, showing the change. **Approve** applies it in the
agent's name and yours; **Reject** leaves the profile as it was. The agent can
follow its ask with `profile_request_status`, and `send_profile_now` has the
hub deliver at once.

## Connect an agent outside Magnesium

The **Tools** tab shows the hub's MCP address, with **Copy MCP URL**. Point an
agent outside Magnesium at it, such as Claude Code in your own terminal: it
signs in once, and you choose whether it may only read or may also ask for
changes. See [Outside agents](./outside-agents.md) for each agent's steps.

## From a terminal

On the hub, `magnesium-agents` makes and checks profiles without the app:

```bash
magnesium-agents new reviewer --description "Reviews pull requests."
magnesium-agents check reviewer
magnesium-agents list
```

A profile is a folder in `~/.magnesium/profiles/`, and the app edits the same
files. The main settings in its `profile.yaml`:

```yaml
machines: ["*"] # machines it goes to; "*" for all; empty for this server only
harness: claude # or codex, or opencode; harnesses: [claude, codex] offers both
sandbox:
  level: fenced # or container
env: [KB_TOKEN] # names of environment variables it needs, never their values
launch_args: [--add-dir, /data] # extra arguments for the CLI; a list, or one string
display_name: Reviewer
accent: "#2f80ed"
tool_permissions: # per MCP server: allow, ask or off, and per tool
  kb:
    default: ask
    tools: { search: allow, delete_page: off }
```

Optional files: `mcp.json` for the agent's MCP servers (write `${KB_TOKEN}`,
never the token), `hooks.json`, more Markdown instructions, and
`skills/<name>/SKILL.md`. To give agents your knowledge base, add its MCP
server at whatever URL you run it.

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

The other profiles keep working, and a refused profile's machines keep its last
version that passed. The page shows each problem beside the field or file it's
about; `magnesium-agents check` lists them too.
