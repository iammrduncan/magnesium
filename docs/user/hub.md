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

Under **Permissions**, **Manage access** lets the new device add and remove
other devices too. Leave it off for a device that only needs to work.

To sign a device out, choose **Revoke** next to it in the same list.

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

If a browser had a machine added directly, it hands that access to the hub the
first time it is signed in with **Manage access**, then forgets its own copy.

The hub's access to each machine lasts 30 days, and the hub renews it a week
before it runs out. A machine that stays offline past that shows "The hub's
access ran out" under **Hub machines**; give access again.

## Fleet

**Fleet** (the server icon at the bottom of the sidebar, or "Open fleet" in the
command palette) lists the hub and every machine it carries, live: version,
Connected or Offline with when it was last seen, and how many threads are
running and waiting on you. A machine that stops answering shows Offline within
about ten seconds, and comes back on its own when its server returns. To try
an offline machine now instead of waiting, choose **Reconnect**. **Recent**
lists when each machine's link came up or went down.

Agents and command-line sessions cannot reach the hub's machines, even with an
admin token: only devices you paired can.

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
  "Adding a machine".
