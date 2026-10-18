# Upstream changelog

Every upstream T3 Code commit ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) that Magnesium has inspected, and what we did with it. If Magnesium ever breaks badly or drifts far from upstream, start here: the watermark says how far we have read, and the log says what we took, how we took it, and what we chose to skip.

## Watermark

**Last upstream commit fully inspected:** `81493efb71e8e8244f95d3e9f71d8369654ab151`, tag `v0.1.0` (2026-10-15). It and every upstream commit before it are in Magnesium's history.

Commits after the watermark have not all been inspected. The log below lists the ones that have.

To see what upstream has done since:

```bash
git fetch upstream
git log --oneline --no-merges 81493efb71e8e8244f95d3e9f71d8369654ab151..upstream/main
```

Leave out any hash already in the log.

## Log

Newest first. One row per upstream commit, or one row per merge for a whole range.

| Date checked | Upstream commit                                                              | What it is                                                                                  | What we did                                                                                                                                                                                                                                               | Magnesium commit                                  |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 2026-10-17   | `6c8fed35dd..81493efb71` (`v0.0.45..v0.1.0`, 1,051 commits)                  | Orchestrator V2, the scheduler, Effect 4.0.4 and everything else up to v0.1.0               | **Merged** (`scripts/merge-upstream.ts`), every commit in the range. The fence and supervised default moved to V2's homes (`ProviderSessionManager`, `CodexAdapterV2`, `providerPolicy.ts`), and the OpenCode lock retry to `packages/provider-opencode`. | The `v0.1.0` merge commit on `merge/v0.1.0`       |
| 2026-10-14   | `f82796a16abb707c1e2c41301ad8d6e3153668c5` (#17898, 2026-10-10)              | Claude MCP servers go over the CLI's stdin control channel, so the bearer token leaves argv | **Ported by hand.** The upstream commit patches `ClaudeAdapterV2`, which v0.0.45 lacks; the same change was made in `provider/Layers/ClaudeAdapter.ts`. The v0.1.0 merge brought the commit itself and dropped the port.                                  | `ece6e9d41e0f9b22bfdd49720b599b98b182bb17`        |
| 2026-10-14   | `6c8fed35dded9ff71c5b46807125457acbb76be6` (`v0.0.45`) and all its ancestors | The stable release Magnesium forks from                                                     | **Base.** The fork's `main` was reset to this tag before any Magnesium commit (goal 01).                                                                                                                                                                  | `ece6e9d41e` is the first Magnesium commit on top |

## How to record

- **Whenever you merge, cherry-pick, port or deliberately skip upstream commits,** add a row here in the same commit.
- **"What we did"** is one of:
  - **Merged** (`scripts/merge-upstream.ts`);
  - **Cherry-picked**;
  - **Ported by hand**, saying where and why;
  - **Skipped**, saying why.
- **A merge** is one row for its range (`<old watermark>..<tag>`). It moves the watermark to the merged tag.
- **Name the Magnesium commit** that brought the change in.
