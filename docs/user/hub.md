<!-- magnesium: how to use the hub from every device (D38, doc 11 "The front door") -->

# The hub: every machine on every device

Magnesium runs a server on each machine that runs agents, plus one hub. Your
devices sign in to the hub only. The hub carries every machine, so a phone or
laptop you sign in once sees every machine, project and thread, without pairing
each machine on it.

## Sign in your first device

Do this once, on the device you will manage Magnesium from. On the hub, run:

```bash
~/.local/share/magnesium/bin/magnesium-release pair --admin
```

It prints a link, a code and a QR code. Open the link on your device within 15
minutes; it works once. That device can now add other devices.

Run it in your own terminal, not through an agent, so the link stays out of
agent transcripts.

## Add a phone or another computer

On a device that can add others, open **Settings → Connections → Authorized
clients** and choose **Create link**. Scan the QR code with the new device, or
open the link on it. It shows every machine straight away.

Under **Permissions**, **Manage access** (on by default) lets the new device add
and remove other devices, and change servers from Fleet. Turn it off for a
device that only needs to work.

To sign a device out, choose **Revoke** next to it in the same list.

## Install it as an app

On a computer, Magnesium installs as an app with its own window and Dock or
taskbar icon. Open the hub's HTTPS address, then:

- **Chrome or Edge:** choose the install icon at the right of the address bar.
- **Safari on a Mac:** choose **File → Add to Dock**.

The installed app opens even when the hub can't be reached, and shows
**Offline** rather than old threads. Choose **Retry**, or wait: it tries again
when your network comes back. Pairing links need the hub, so open them when it
is running.

## Machines

Machines the hub carries appear under **Environments** as "Through the hub".

- **Hide a machine on one device:** switch it off in its row. Other devices
  still see it.
- **Take a machine away from every device:** choose **Remove hub access…** in
  its row menu.
- **Give the hub access to a machine:** machines the hub cannot reach yet are
  listed under **Hub machines**. On the machine, run
  `~/.local/share/magnesium/bin/magnesium-release pair`, then choose
  **Give access** and enter the code. This needs a device that can manage
  access.
- **Add a machine:** in **Fleet**, choose **Add a machine** and give its name,
  its address and a pairing code from it (its **Settings → Connections**, or
  `magnesium-release pair` there). The hub keeps it in its own list, so a later
  deploy of the hub doesn't drop it.
- **Forget a machine:** in **Fleet**, choose it, then **Forget**. It leaves
  the hub's list, and the hub's access to it ends on the machine too. Add it
  again with a new pairing code. **Give access again** takes a new code for a
  machine the hub still lists; the token it replaces stops working.

To work on a project on another machine, open a new thread in it and pick the
machine under **Run on** below the composer. A machine that doesn't have the
project yet is under **Add to another machine**: it clones the project's
repository there and copies the files git ignores that you tick, such as
`.env`. Folders git ignores whole, like `node_modules`, are left out. The
project needs a git remote.

If a browser had a machine added directly, it hands that access to the hub the
first time it is signed in with **Manage access**, then forgets its own copy.

The hub's access to each machine lasts 30 days, and the hub renews it a week
before it runs out. A machine that stays offline past that shows "The hub's
access ran out" under **Hub machines**; give access again.

## Fleet

**Fleet** (under the search box in the sidebar, where a red dot means a machine
is offline, or "Open fleet" in the command palette) lists the hub and every
machine it carries, live: version, Connected or Offline with when it was last
seen, and how many threads are running and waiting on you. A machine that stops
answering shows Offline within about ten seconds, and comes back on its own when
its server returns. To try an offline machine now instead of waiting, choose
**Reconnect**. **Recent** lists when each machine's link came up or went down.

Choose a server to see its panel, beside the list on a wide screen or in a
sheet on a phone. Each row also notes what needs a look: a build that isn't
the hub's, a backup that failed or is more than two days old, or a clock on
another time zone.

- **Update** puts a server on the hub's build. A machine like the hub gets the
  hub's own build; one on another OS or processor builds that commit from the
  source it was installed from, which takes a few minutes. A Magnesium pod
  changes image through its gateway. The server restarts, and if the new build
  doesn't start, it goes back to the one it had and Fleet says why.
- **Roll back** restarts a server on the build it ran before. Rolling the hub
  back reloads this page when the hub is back.
- **Backups:** every server backs itself up daily and before each update, rollback or restore. It keeps one backup a day for its last seven days, and its three newest.
  **Backups** lists them, with **Back up now** and **Restore…**. A restore
  stops the server, keeps the state it replaces as a backup of its own, and
  starts it again; closing the page doesn't stop it. A failed backup is a card
  on **Home** until one works.
- **Time zone:** each server's scheduled tasks run on its own clock, so a
  server on another zone than the hub gets a warning, and a task's schedule
  names its zone.

A machine attached inside a workload gets its build from that workload's
deploy, so Fleet shows when it's behind but offers no Update or Roll back
there. A server with nothing to start it again, such as one run by hand, can't
update or restore itself from Fleet; use `magnesium-release` on it.

Changing a server (Update, Roll back, Back up now, Restore) needs a device
that can manage access, as adding a machine does; any paired device can see
Fleet and its backups.

The command palette has the same actions: **Add a machine**, and **Update**,
**Roll back** and **Back up now** for each server.

Agents can read Fleet too, and ask for any of these changes with Magnesium's
tools (`list_machines`, `list_backups`, `update_server`, `rollback_server`,
`backup_now`, `restore_backup`, `add_machine`, `forget_machine` and
`edit_pod`). Each ask is a **Fleet change** card on Home: **Approve** carries it
out, **Reject** leaves everything as it was.

Agents and command-line sessions cannot reach the hub's machines, even with an
admin token: only devices you paired can.

## Home

**Home** gathers what needs you on every machine: approvals, questions, plans
ready to implement, and failed runs. Answer each where you see it. An answer
waits five seconds before it is sent, so **Undo** can take it back. A
scheduled task whose run could not start shows here too, with **Retry now**;
beside the feed, **Next scheduled runs** lists what runs soon and how each
task's last run went. Scheduled tasks themselves are set up in **Settings →
Scheduled tasks**. A machine that goes offline keeps its cards on Home, but
they can't be answered until it is back.

## The footer

The bar along the bottom of every page shows how many machines the hub reaches
and how many are offline, and how many threads need you across all of them.
Hover an item for what its label leaves out, such as a machine whose threads
can't be counted while it is offline. Click it to see each machine; from
**Needs you**, open a waiting thread. **+ Footer** chooses which items show,
and the choice is kept on that device. While the hub can't be reached, the
footer says **Offline** instead of showing old numbers.

## Profiles

The hub holds your profiles and sends each to the machines it names; see
[Profiles and sandboxes](./profiles-and-sandboxes.md).

## If something is missing

- **No Create link button:** this device cannot add others. Sign it in with an
  admin link from the hub, or create a link with **Manage access** from a device
  that has it.
- **A machine shows Offline:** its server is down. On the machine,
  `systemctl --user status magnesium` shows why.
- **Adding a new machine to the hub:** see the deploy runbook,
  [`magnesium/deploy/ansible/README.md`](../../magnesium/deploy/ansible/README.md),
  "Adding a machine". In Kubernetes, in its own pod or inside a workload's
  pods, see [Machines in Kubernetes](./kubernetes.md).
