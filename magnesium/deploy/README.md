# @magnesium/deploy

Deploy assets for Magnesium. Goal 02's roles install them; until then they are
applied by hand.

- `systemd/magnesium.service`: the server as a user unit. Every unit here sets
  `T3CODE_TELEMETRY_ENABLED=false`, keeps state in `~/.magnesium` (never in a
  T3 Code home), and drops stdout so pairing tokens stay out of the journal.
  To pair, run `magnesium-release pair [--admin]` on the host.
- `seed/settings.json`: written to `$T3CODE_HOME/userdata/settings.json` when
  that file does not exist yet. New threads start supervised, and the provider
  update checks, which poll npm and T3 Code's model manifest, stay off.

- `bin/magnesium-release`: builds a commit into `~/.local/share/magnesium/releases/<sha>`, switches the `current` symlink the unit runs, and restarts the unit. `magnesium-release rollback` goes back to the previous release in one command.

  ```bash
  magnesium-release build <git-ref> <repo-url-or-path>
  magnesium-release activate <sha>
  magnesium-release rollback
  magnesium-release status
  magnesium-release pair [--admin]
  ```

- **Agents and their fence** (goal 03; D40, D44, D45). These ship in every release and pack, and profile sync points provider instances at them. Nothing to install.
  - `bin/magnesium-fence`: runs a command fenced, so it can't read or write the state home (`T3CODE_HOME`) or change the paths in `MAGNESIUM_FENCE_PROTECT` (the install, the unit and its env file). It uses bubblewrap where it runs, else a user namespace of its own, else Landlock alone (both through Python 3, `bin/magnesium-fence-helper`), else macOS Seatbelt. `magnesium-fence --probe` says which; `--probe NAME` says whether one works here, and `MAGNESIUM_FENCE=NAME` forces it.
  - `bin/magnesium-fenced`: a stock Claude, Codex or OpenCode instance, fenced.
  - `bin/magnesium-claude`, `bin/magnesium-codex` (`bin/magnesium-wrapper`): a profile's harness at its level: `fenced`, `container` (rootless Podman, the host's CLI mounted read-only) or `native`. Each start is logged to the profile's `.magnesium/wrapper.log`.
  - `bin/magnesium-agents`: `list`, `check`, `sandboxes` and `new` for profiles; the role links it into `~/.local/bin`.
  - The container level is off until `magnesium_sandbox_image` names a base image pinned by digest; the role pulls it. Profiles name machines by `magnesium_machine_name` (the hub is `hub`).

`vp run --filter @magnesium/deploy test` checks the unit, the seed, the release switching, the wrappers and every fence this host can run.

`ansible/` rolls these out to every machine and the hub; see [its README](ansible/README.md).
