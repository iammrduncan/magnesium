# @dbrain/deploy

Deploy assets for Magnesium. Goal 02's roles install them; until then they are
applied by hand.

- `systemd/magnesium.service`: the server as a user unit. Every unit here sets
  `T3CODE_TELEMETRY_ENABLED=false` and keeps state in `~/.magnesium`, never in
  a T3 Code home.
- `seed/settings.json`: written to `$T3CODE_HOME/userdata/settings.json` when
  that file does not exist yet. New threads start supervised, and the provider
  update checks, which poll npm and T3 Code's model manifest, stay off.

`npm test` here (`vp run --filter @dbrain/deploy test`) checks both rules.
