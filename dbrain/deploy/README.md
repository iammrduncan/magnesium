# @dbrain/deploy

Deploy assets for Magnesium. Goal 02's roles install them; until then they are
applied by hand.

- `systemd/magnesium.service`: the server as a user unit. Every unit here sets
  `T3CODE_TELEMETRY_ENABLED=false` and keeps state in `~/.magnesium`, never in
  a T3 Code home.
- `seed/settings.json`: written to `$T3CODE_HOME/userdata/settings.json` when
  that file does not exist yet. New threads start supervised, and the provider
  update checks, which poll npm and T3 Code's model manifest, stay off.

- `bin/magnesium-release`: builds a commit into `~/.local/share/magnesium/releases/<sha>`, switches the `current` symlink the unit runs, and restarts the unit. `magnesium-release rollback` goes back to the previous release in one command.

  ```bash
  magnesium-release build <git-ref> <repo-url-or-path>
  magnesium-release activate <sha>
  magnesium-release rollback
  magnesium-release status
  ```

`vp run --filter @dbrain/deploy test` checks the unit, the seed and the release switching.
