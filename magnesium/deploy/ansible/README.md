# Deploying Magnesium

`magnesium.yml` puts a Magnesium server on every agent machine and on the hub (D15, D35). Each host runs the server as a systemd user service for its own user. A host keeps its previous release, so one command rolls it back.

Magnesium needs two kinds of address, on any network: **the hub's URL**, which your devices open, and **each machine's URL**, which only the hub needs to reach. Nothing here requires Tailscale.

**Status:** in use since goals 02 and 04.

## Pick a setup

- **A single box.** The hub is the only server, and it runs the agents itself. Put the one host under `magnesium_hub` in the inventory, leave `magnesium_servers` empty, and leave `magnesium_hub_machines` empty.
- **A hub and machines on a LAN, or any network.** Each machine's server listens on an address the hub reaches; set `magnesium_host` per machine to it, such as `192.0.2.21`. List each machine for the hub as `{name, url}`, such as `{name: cpu-a, url: "http://192.0.2.21:3773"}`. Then lock direct access to the machines down (below).
- **On a tailnet.** As on a LAN, with tailnet addresses. A machine with Tailscale installed and an empty `magnesium_host` binds its tailnet IPv4.
- **Machines in Kubernetes.** The hub stays on a host or VM with these roles; each machine runs as a pod from Magnesium's image instead. List each one for the hub as `{name, url}` like any machine. See [the Kubernetes README](../kubernetes/README.md).

The role stops on a machine with no `magnesium_host` and no Tailscale, and asks for the address.

## The hub's front door

Point your devices at the hub, by `magnesium_hub_public_url` (the URL pairing links use). The hub's own server listens on `magnesium_host`:

- **`127.0.0.1` behind a reverse proxy** that gives it HTTPS with a certificate your devices trust. Forward WebSocket upgrades on `/ws` and `/api/`.
- **A LAN address,** for plain HTTP on a trusted network. The UI works, but installing the PWA and push notifications need HTTPS.
- **A Tailscale Service:** set `magnesium_hub_publish: true` and the role publishes the hub with `tailscale serve` (it needs root or the tailscale operator right). This is optional and off by default.

## Only the hub reaches a machine

Your devices never talk to a machine's server; they go through the hub (D38). Close the direct path with any of these:

- **Bind to an interface only the hub reaches:** set the machine's `magnesium_host` to the address on a network your devices are not on, such as a private VLAN or a back-to-back link.
- **A host firewall rule** on the machine, letting only the hub's address reach the port. With ufw:

  ```bash
  sudo ufw allow from <hub address> to any port 3773 proto tcp
  sudo ufw deny 3773/tcp
  ```

  Or with nftables, as a table of its own (`sudo nft -f magnesium.nft`, and include it from `/etc/nftables.conf` to keep it):

  ```text
  table inet magnesium {
    chain input {
      type filter hook input priority 0; policy accept;
      tcp dport 3773 ip saddr != <hub address> drop
    }
  }
  ```

- **Tailscale ACLs:** grant `tcp:3773` on the machines to the hub only, and make sure no broader grant reaches it:

  ```json
  { "src": ["tag:magnesium-hub"], "dst": ["tag:magnesium-machine"], "ip": ["tcp:3773"] }
  ```

Check it from a phone or laptop: the machine's `http://<address>:3773/` is refused, and every machine still works in the hub.

## Setup

1. **Copy the examples** to their git-ignored names: `inventory.example.yml` → `inventory.yml`, and each `group_vars/*.example.yml` → `group_vars/*.yml`. Fill in your hosts; keep the real ones out of this repo.
2. **Install Ansible on the admin machine.** It needs 2.19 or later, for example `uvx --from ansible-core ansible-playbook`.
3. **Each host has `git`, `xz-utils` and `ca-certificates`.** The role installs Node 24 per user, checked against a pinned checksum. The admin machine reaches each host over SSH as its server user.

## Day to day

| Change                                   | Run                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview a rollout                        | `ansible-playbook magnesium.yml --check --diff`                                                                                                   |
| Roll out the pinned build everywhere     | `ansible-playbook magnesium.yml`                                                                                                                  |
| Roll out one host, or a different commit | `ansible-playbook magnesium.yml -l <host> -e magnesium_version=<commit>`                                                                          |
| Settings and units only                  | `ansible-playbook magnesium.yml --tags config`                                                                                                    |
| Update or roll back one host             | **Update** or **Roll back** in Fleet; or on the host: `~/.local/share/magnesium/bin/magnesium-release rollback`                                   |
| Back up a host's state now               | **Back up now** in Fleet; or on the host: `~/.local/share/magnesium/bin/magnesium-release backup`                                                 |
| Restore a backup                         | **Restore…** in Fleet; or on the host: `ls ~/.magnesium/backups`, then `~/.local/share/magnesium/bin/magnesium-release restore <name>`            |
| See what a host runs                     | on the host: `~/.local/share/magnesium/bin/magnesium-release status`                                                                              |
| Pair a new device with the hub           | in Settings → Connections → Authorized clients, **Create link**, and scan its QR code. The device sees every machine (D38).                       |
| First admin device (once)                | on the hub: `~/.local/share/magnesium/bin/magnesium-release pair --admin`, then open the link on the desktop                                      |
| Give the hub access to a machine         | on the machine: `~/.local/share/magnesium/bin/magnesium-release pair`, then Settings → Connections → Hub machines → **Give access** with the code |

The unit drops the server's stdout, so a startup pairing token never reaches the journal. Pair on demand instead.

**Backups:** the server backs up `~/.magnesium/userdata` itself, daily, and every activate backs it up first. That way a rollback past a database migration has a copy to restore. They are kept in `~/.magnesium/backups`: the newest of each of the last seven days, and the three newest. Logs are left out: the server caps its own, and journald rotates the rest. A restore stops the server and backs up the state it replaces first.

## Adding a machine

1. **Inventory:** add it to `magnesium_servers`, with `magnesium_host` set to the address the hub reaches it on (or leave it empty on a tailnet). If it has no Claude Code or Codex login, also add it to `magnesium_opencode`.
2. **Model gateway key:** for an OpenCode machine, put the key for your OpenAI-compatible gateway (LiteLLM, say) in `~/.config/magnesium/litellm.env`, as `LITELLM_API_KEY=...`, mode 0600 (D36). This role only checks that the file exists and is private.
3. **Roll out:** run `ansible-playbook magnesium.yml -l <machine>`, and close its direct path ("Only the hub reaches a machine").
4. **On the hub:** in Fleet, **Add a machine** with its name, its address and a pairing code from `magnesium-release pair` on it. Every device signed in to the hub then sees the machine. Or list it in `magnesium_hub_machines` and roll out the hub with `--tags config`, then give the hub access from Settings → Connections → Hub machines with the code; a machine added in the app stays through later deploys either way.

## Hosts that don't build

A host that shouldn't spend the time or space on builds, such as a small hub, names a `magnesium_build_host` in its vars. Its own agents still need their way out to npm, GitHub and the web, so keep that open.

1. The role builds the pinned commit on that host.
2. It packs the server and its runtime dependencies there, about 300 MB.
3. It fetches the pack to the admin machine, copies it to the hub, then unpacks and activates it.

## Reaching machines through a relay

If the hub can reach a machine only through a TCP relay on its own loopback (a socket-activated `systemd-socket-proxyd` unit, say), list it as `{name, relay_port}`; the role writes `http://127.0.0.1:<port>`.

To check the roles' network choices without a host: `ansible-playbook -i localhost, -c local tests/network.yml` (also run by `magnesium/deploy`'s tests when Ansible is installed).
