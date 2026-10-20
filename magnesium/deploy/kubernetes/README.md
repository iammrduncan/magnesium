# Running a machine server in Kubernetes

**Attach it to the workloads that do the work** ([below](#attaching-to-a-workload), D59): a machine server is most useful inside the pod whose files, tools, GPUs and models the agents should use. A spoke of its own, as the rest of this page describes, suits a machine whose only job is Magnesium.

A Magnesium machine server (a spoke) can run as a pod, as well as on bare metal or in a VM with [the Ansible roles](../ansible/README.md) (goal 25, D52). The hub stays where the roles put it. Your cluster gives Magnesium a namespace and an envelope; Magnesium deploys its spokes there itself, through a gateway you bootstrap once ([doc 15](../../../docs/magnesium/15-magnesium-as-a-product.md), D57). This folder is the spoke's contract: the image, what it needs at run time, and how to move a machine into it. [`spoke.yaml`](spoke.yaml) is a reference manifest for one spoke, with placeholder values.

## The image

[`../container/Containerfile`](../container/Containerfile) builds one from the repo root at a pinned commit:

```bash
podman build -f magnesium/deploy/container/Containerfile \
  --build-arg MAGNESIUM_COMMIT=<10-character sha> -t magnesium:<sha> .
```

- **The server** is the same pack `magnesium-release pack` makes, built on the image's own base, in `/opt/magnesium-portable/releases/<sha>` with `current` pointing at it. Fleet shows the commit, and the fence protects the install.
- **The bundle,** `/opt/magnesium-portable`, is the whole install: the server, Node, OpenCode, and what an attached server can't count on finding (git, a Python for the fence, tini), built to run on glibc 2.28 and later.
- **For agents:** Node 24, git, Python 3, build-essential, curl, jq, ripgrep, and OpenCode at the version the roles pin. Add more only when a project needs it.
- **A user with uid 10001.** It needs no capabilities.
- **The build reaches** the npm registry, Debian's and AlmaLinux's mirrors, and the GitHub releases of OpenCode, python-build-standalone and tini (each checked against a pinned checksum). Base images are pinned by digest.

The image is the release. There is no build, activate or rollback inside a pod: run a new image to upgrade, and the previous one to roll back.

## Attaching to a workload

An attached server runs inside the workload's own container, beside its process, so agents see what the workload sees. The workload's image doesn't change:

1. **An init container** from the Magnesium image copies the bundle into an `emptyDir`: `/opt/magnesium-portable/bin/magnesium-bundle-copy /bundle`, which works as any uid (`cp -a` doesn't, on the bundle's read-only folders). Mount that at `/opt/magnesium-portable` in the workload's container, read-only.
2. **Wrap its command:** `/opt/magnesium-portable/bin/magnesium-attach -- <the workload's command>`. A pod's `command` replaces the image's entrypoint, so restate it in full. The workload stays the main process: it gets the signals, and the container ends with its exit status. The server runs beside it and starts again when it stops.
3. **Give it a home:** a volume for `MAGNESIUM_HOME`, which holds Magnesium's state and the agents' own sign-ins. Moving a machine in, mount it at the machine's old home path, since projects are kept by absolute path.
4. **Its environment:**

   | Variable                     | What                                                                                     |
   | ---------------------------- | ---------------------------------------------------------------------------------------- |
   | `MAGNESIUM_HOME`             | The home volume (required).                                                              |
   | `MAGNESIUM_MACHINE`          | The name the hub knows it by. Keep a moved machine's name, and the hub keeps its access. |
   | `MAGNESIUM_WORKLOAD`         | The workload's name, which Fleet shows: "in notebook on node-a".                         |
   | `MAGNESIUM_NODE`             | `spec.nodeName` through the downward API.                                                |
   | `T3CODE_PORT`                | Its port, 3773 by default. In a host-network pod, pick one the host isn't using.         |
   | `MAGNESIUM_HUB_PAIRING_CODE` | For a new machine, from a Secret, as for a spoke.                                        |

5. **Reach it through the gateway:** a Service `magnesium-<machine>` in the workload's namespace, an `ExternalName` of the same name in the gateway's namespace pointing at it, and network policies that let the gateway reach the pod on that port.
6. **Let the hub find it.** Label that `ExternalName` with `magnesium.dev/attached: <machine>` (and `magnesium.dev/workload: <workload>`, which Settings shows). For a new machine, also put its one-time code in a Secret `magnesium-<machine>-pairing` in the gateway's namespace, key `MAGNESIUM_HUB_PAIRING_CODE`: the same code as in the workload's own Secret, since a pod can't read across namespaces. Within a minute the hub finds it through the gateway, attaches it and pairs once it answers; nobody types the code. Then the gateway labels the route `magnesium.dev/paired: "true"` and deletes the Secret, so write the code only while that label is absent, or every redeploy brings back a spent one. A machine moved in from elsewhere keeps the hub's access and needs no code.

The hub shows an attached machine and uses it, but starting, stopping and removing it stay with the workload's own deploy: take Magnesium out of the workload and its route goes, and Settings says so; only then does Detach let it go. Settings → Connections → Add environment → Attach a workload's machine also attaches one by hand, with its code, for a setup without the labels.

It runs as the container's uid, with the container's privileges and devices: agents in a GPU workload can use its GPUs, and agents in a privileged pod are as privileged as it is. The fence is Landlock alone, as in any pod. Attach to unprivileged workloads unless you mean otherwise.

## What a pod needs

| What                    | Value                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Volume**              | One `ReadWriteOnce` volume mounted as `HOME`. Moving a machine: mount it at the same path as that user's home before, because projects, worktrees and checkpoints are stored by absolute path.                                                                                                                                                                                            |
| **`HOME`**              | That path. The state lives in `$HOME/.magnesium`; provider logins and any CLIs the user installs live in the home too, so they survive a new image.                                                                                                                                                                                                                                       |
| **`MAGNESIUM_MACHINE`** | The name the hub knows this server by. Keep it when moving a machine.                                                                                                                                                                                                                                                                                                                     |
| **`MAGNESIUM_NODE`**    | Where it runs, which Fleet shows beside its name: `spec.nodeName` through the downward API, or a description of your own.                                                                                                                                                                                                                                                                 |
| **Host name**           | The pod's `hostname`, which Fleet and Home show as the server's label. Without it they show the pod's generated name, which changes on every start. Moving a machine: its host name, in lowercase.                                                                                                                                                                                        |
| **OpenCode**            | `MAGNESIUM_OPENCODE_BASE_URL` (an OpenAI-compatible gateway, such as LiteLLM) and `MAGNESIUM_OPENCODE_MODELS` (comma-separated; the first is the default). On every start the entrypoint writes `~/.config/opencode/opencode.json` from them, and turns OpenCode on in Magnesium's settings with that default model unless Settings already chose otherwise; unset, it leaves both alone. |
| **Time zone**           | `MAGNESIUM_TIMEZONE`, such as `Europe/Berlin`: the server's clock, which scheduled tasks run by. Give every server the same one, the gateway too: it passes its own to the spokes it deploys. In an attached workload it sets only the server's clock, not the workload's. Unset: UTC, or the container's own zone.                                                                       |
| **Secrets**             | By name only, as environment variables from a Secret that Magnesium writes from the hub's secret store: `LITELLM_API_KEY` for OpenCode, for now. Never put a capability secret in a spoke ([doc 15](../../../docs/magnesium/15-magnesium-as-a-product.md)).                                                                                                                               |
| **Pairing**             | `MAGNESIUM_HUB_PAIRING_CODE`, from a Secret: a random code of 16 or more characters that the hub uses once to give itself access, as with a code from `magnesium-release pair`. It lasts a week from the first start, pairing spends it, and a restart never re-arms it. Leave it unset for a spoke the hub already has access to.                                                        |
| **Port**                | 3773, HTTP and WebSocket. The image binds `0.0.0.0`.                                                                                                                                                                                                                                                                                                                                      |
| **Health**              | `GET /.well-known/t3/environment` answers 200 once the server serves. Allow a slow first start for database migrations.                                                                                                                                                                                                                                                                   |
| **Rollout**             | A StatefulSet with one replica: its pod has a stable name, `magnesium-<name>-0`, and a rollout removes the old pod before it starts the next. Two pods on one SQLite database corrupt it.                                                                                                                                                                                                 |
| **Security**            | Pod security `restricted`: uid and gid 10001, `fsGroup` 10001, every capability dropped, `RuntimeDefault` seccomp, no privilege escalation, a read-only root with `/tmp` as an `emptyDir`, and no service-account token. No host paths, GPUs or host network.                                                                                                                             |
| **Stop**                | SIGTERM is a clean stop; 30 seconds is enough. Agents stop with the pod.                                                                                                                                                                                                                                                                                                                  |

The server's own logs go to stderr and to `$HOME/.magnesium/userdata/logs`. The pairing token it prints at start never reaches the pod's log.

## Reaching it: the gateway

Only the hub reaches a spoke (D38), and in Kubernetes it does so through one **gateway** per namespace: the same image, run with `MAGNESIUM_ROLE=gateway`. [`gateway.yaml`](gateway.yaml) is its reference manifest. Publish the gateway's Service to the hub alone; the spokes stay unpublished behind it.

- **Routes:** `<gateway>/spokes/<name>/…` goes to the spoke's Service in the namespace, HTTP and WebSocket alike. A spoke's Service must be named `magnesium-<name>`, on port 3773; `MAGNESIUM_SPOKE_URL` (a template with `{name}`) changes that.
- **It holds no credentials for spokes.** The hub's own token for each spoke passes through, and the spoke checks it as at its own address.
- **The hub's entry for a spoke** in `magnesium_hub_machines` is `{name, url: "https://<gateway>/spokes/<name>"}`, with `name` equal to the spoke's `MAGNESIUM_MACHINE`. The hub reads its machine list without a restart.
- **What the gateway needs at start:** `HOME` on a small volume of its own (its state), `MAGNESIUM_ROLE=gateway` and `MAGNESIUM_MACHINE=gateway`. Port 3773, and the same health check as a spoke. Its deploy identity, a service account limited to the namespace, deploys the spokes.
- **Deploying spokes:** the hub asks the gateway to run, change, stop or remove a spoke, and the gateway applies its objects (its volume, Secret, Service and StatefulSet, as in `spoke.yaml`) with its deploy identity, using server-side apply. The deploy identity needs, in the namespace only: `create`, `get`, `list`, `watch`, `patch`, `update` and `delete` on StatefulSets, Deployments (to retire a spoke's from before StatefulSets), Services, Secrets and PersistentVolumeClaims, and `get` and `list` on pods and events (why a spoke isn't starting). `MAGNESIUM_SPOKE_IMAGE` names a build's image, a template with `{build}` (such as `localhost/magnesium:{build}`); a spoke without a build runs the gateway's own. `MAGNESIUM_SPOKE_STORAGE_CLASS` picks the volumes' storage class. A refusal from the cluster (a node outside the allowed list, say) comes back to Fleet in the cluster's words.
- **Pairing the hub with the gateway, once:** put a random `MAGNESIUM_HUB_PAIRING_CODE` in the gateway's Secret, and give it to the hub in Settings → Connections → Hub machines → **Give access**.

Outside Kubernetes, publish a spoke's port to the hub alone and add `{name, url}` for it directly.

The hub's access survives a move, because it lives in the machine's state. A spoke that starts with no state gives the hub access with a `MAGNESIUM_HUB_PAIRING_CODE` in its Secret, or, as on bare metal, with `magnesium-release pair` run in the pod; then **Give access** with the code in Settings → Connections → Hub machines.

## Sandboxes in a pod

- **Fenced**, the default, works. With `RuntimeDefault` seccomp and no capabilities, the fence uses Landlock: agents can't read or change the state home, and the home folder's top level can't be listed. `magnesium-fence --probe` in the pod names the fence it uses. Don't loosen seccomp for a stronger one.
- **Container** is not available in a pod; Settings → Connections → Sandboxes says so. Move any profile set to `container` on that machine to `fenced` before moving it; `magnesium-agents check` lists them. A sandbox that runs each agent session in a pod of its own comes with goal 19. Until then, run no headless or scheduled work on a pod spoke.
- **Native** is as everywhere: per thread only.

Provider logins work from inside the pod: Settings → Providers → **Sign in**, or Fleet → **Terminal**.

## Moving a machine from bare metal

1. Answer or stop the requests waiting on that machine, then run `~/.local/share/magnesium/bin/magnesium-release backup` there.
2. Stop and disable the user service: `systemctl --user disable --now magnesium.service`. Keep it installed for rollback.
3. Copy into the volume, at the same paths, owned by 10001:10001:
   - **Carry:**
     - `~/.magnesium/`, all of it (the database with its `-wal` and `-shm`, so copy with the server stopped);
     - Claude Code's `~/.claude/` and `~/.claude.json`, and a native install (`~/.local/share/claude/`, `~/.local/bin/claude`);
     - Codex's `auth.json` and `config.toml` from `~/.codex/` (and any instructions files there), and its binary if it lives under `~/.local`. A harness installed outside the home, such as Codex as a global npm package, doesn't come along: install the same version into the new home's `~/.local` (`npm i -g --prefix ~/.local @openai/codex@<version>`), which comes first on the server's `PATH`. Carry `~/.codex/sessions/` only where Magnesium's threads use Codex and should keep their live context; without it an old Codex thread keeps its messages but starts its conversation fresh. Leave Codex's logs, log databases, archived sessions and caches, which can be gigabytes;
     - OpenCode's `~/.local/share/opencode/` and `~/.local/state/opencode/`;
     - `~/.gitconfig`;
     - every project folder outside `~/.magnesium`. Get the list from a copy of the database: `SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL`.
   - **Leave:**
     - `~/.local/share/magnesium/` (releases, Node and OpenCode, which the image replaces) and the links into it in `~/.local/bin`;
     - `~/.config/magnesium/` (its env file becomes the pod's environment and Secret) and `~/.config/systemd/`;
     - `~/.ssh`;
     - caches such as `~/.cache`, `~/.npm` and pnpm stores.
4. Start the pod and wait for its health check, then point the hub's entry for the machine at it.
5. Check in Fleet that the machine is Connected on the expected build, open one of its old threads, and start a new one.

**Rollback:** stop the spoke (Settings, or scale its StatefulSet to zero), run `systemctl --user enable --now magnesium.service`, and point the hub's entry back. Work done in the pod since the move stays in the volume; copy back what you need.

**Retiring the bare metal,** once you no longer want that rollback:

1. Take the machine out of your Ansible inventory first, or the next release run reinstalls and starts the service beside the pod.
2. As the machine's user, remove the units (`magnesium.service` with its `.d`, `magnesium-backup.service` and `.timer`) and reload systemd. Then remove `~/.local/share/magnesium` and its links in `~/.local/bin`, `~/.config/magnesium`, and `~/.magnesium` with its backups (the volume holds the state now).
3. Remove what Magnesium set up for its agents there: `~/.config/opencode`, OpenCode's data in `~/.local/share/opencode` and `~/.local/state/opencode` (the volume has a copy), and the container sandbox's image from the user's Podman store.
4. Retire the machine's own model key and its direct route from the hub.

## Day to day

| Change    | How                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade   | Build the new commit's image and change the spoke's build in Settings. The old pod stops before the new one starts; a new release may migrate the database on start. |
| Roll back | Run the previous image. Restore a backup first if the newer release migrated the database.                                                                           |
| Back up   | Run `magnesium-release backup` on a schedule (a CronJob on the same node, with the same volume, `HOME` and uid). Backups land in `$HOME/.magnesium/backups`.         |
| Restore   | Stop the spoke, run `magnesium-release restore <name>` in a one-off pod with the volume, then scale it back to one.                                                  |
| Pair      | `magnesium-release pair` in the pod.                                                                                                                                 |

In an attached workload, run the same commands as `/opt/magnesium-portable/bin/magnesium-release` in the workload's container. The bundle's tools work on the server's home (`MAGNESIUM_HOME`), not the workload's, so backups land in `$MAGNESIUM_HOME/.magnesium/backups`.
