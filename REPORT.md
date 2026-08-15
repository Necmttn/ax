# w2-cli-mcp report

Status: DONE

## Result

The branch starts at `04911a66` on `origin/v2/duckdb`.

That base commit merges the prerequisite slice `w2-sidecar-judgments` (PR #801).

The branch contains six coherent commits.

The MCP server now selects one typed runtime for each tool.

The runtime sets are cache, judgment, cache plus judgment, and legacy.

The server creates each runtime only when a tool needs it.

Cache and judgment tools do not construct `AppLayer`.

The real MCP process test uses `AX_DB_URL=ws://127.0.0.1:1/rpc`.

The test calls cache and judgment tools in one process.

Request-time `hook_fire` writes now use a synced JSONL spool.

The spool has one 1 MiB active file and one rotated file.

Each record has a 64 KiB limit.

A separate spool lock controls append, rotation, and drain snapshots across processes.

The drain copies both retained files while it holds the spool lock.

The drain releases the spool lock before it writes to DuckDB.

The request path waits for the spool lock for 20 ms at most.

The hook fails open if the spool is not available.

The request path does not acquire `CacheWriteService`.

The request path does not write to the judgment SQLite database.

The drain accepts an explicit `CacheWriteService` from ingest.

The drain skips a torn tail and upserts complete rows by stable ID.

The drain keeps the bounded files because truncation can race with request appends.

The write-aware stage descriptor stays outside the current stage registry.

This avoids duplicate writer ownership before the live writer branch merges.

I did not copy SQL from `feat/v2-w2-live-writers`.

## Commits

- `a7b881e5` `feat(v2): read hook log from DuckDB cache`
- `24032a0c` `feat(v2): run hook backtests from cache`
- `f8001603` `feat(v2): report cache failures at MCP boundary`
- `5c744f22` `feat(v2): read hook dedup from cache`
- `0e973bc8` `feat(v2): isolate MCP tool runtimes`
- `f6a58a55` `feat(v2): spool hook fire telemetry`

## Integration

The six commits move from base `e54690de` to base `04911a66`.

`git range-diff` reports each commit as equal after the rebase.

The rebase has no conflict, because `origin/v2/duckdb` and `e54690de` have the same tree.

The rebase preserves the per-tool MCP runtimes and the hook fire spool.

The rebase changes no live-dependent caller.

## Verification

- The focused test run passes 152 tests in 12 files, with 0 failures.
- An earlier draft of this report recorded 91 tests in 12 files. That count is wrong.
  The focused set holds the 12 test files that cover the modules the six commits
  change. `apps/axctl/src/hooks/file-context-hook.test.ts` supplies 69 of the tests.
  The earlier count omitted that file, although the dedup commit changes
  `file-context-hook.ts`. The 152 figure is the measured count after the rebase.
- The process tests run with SurrealDB at a dead port.
- The crash test kills the spool writer process after the synced append.
- The drain crash test kills a process after its first DuckDB write.
- The crash marker proves that the first DuckDB write completes before termination.
- The next drain restores both rows without duplicate rows.
- The rotation test forces an append while the drain copies both spool files.
- The torn-tail test drains one complete row and skips one partial row.
- The repeated-drain test keeps one DuckDB row after two drains.
- `bun run typecheck` exits with status 0.
- `bun run check:no-node-fs` exits with status 0.
- `git diff --check` exits with status 0.

## Deferred dependencies

This slice is complete. The items below belong to other slices.

They are deferred work, not blockers of this branch.

The `BLOCKED` marker file is removed, because the two blockers it names are resolved.

The remaining snapshot callers need reader parameters from `feat/v2-w2-live-writers`.

These callers are:

- `apps/axctl/src/cli/commands/ax-cost.ts`
- `apps/axctl/src/cli/commands/ax-directives.ts`
- `apps/axctl/src/cli/commands/ax-dispatches.ts`
- `apps/axctl/src/cli/commands/ax-routing.ts`
- `apps/axctl/src/cli/commands/sessions.ts`
- `apps/axctl/src/cli/commands/signals.ts`
- `apps/axctl/src/cli/session-compare-format.ts`
- `apps/axctl/src/cli/workflows-brief-template.ts`
- `apps/axctl/src/dojo/agenda.ts`
- `apps/axctl/src/dojo/items.ts`
- `apps/axctl/src/dojo/spar.ts`
- `apps/axctl/src/improve/impact.ts`
- `apps/axctl/src/nav/next-links.ts`
- `apps/axctl/src/queries/routing-tune.ts`

The full file-context command also needs cache readers from `feat/v2-w2-read-queries`.

The current stage contract calls `run(ctx)` without a cache writer.

The live writer stack changes this contract to `run(ctx, write)`.

That contract change is the exact dependency for stage registration.

The following MCP tools remain on the explicit legacy runtime:

- `sessions_around`
- `session_show`
- `skills_weighted`
- `session_metrics`
- `sessions_churn`
- `signal_show`
- `cost_models`
- `cost_split`
- `cost_images`
- `cost_routability`
- `otel`
- `runs_evidence`
- `dispatches`
- `dispatches_advice`
- `dojo_agenda`

These tools stay on the legacy runtime until their reader branches land.

The per-tool MCP blocker is resolved.

The request-time hook writer blocker is resolved.

The reader branches and the writer-aware stage contract define the deferred work.

That work belongs to `feat/v2-w2-live-writers` and `feat/v2-w2-read-queries`.

This branch leaves every live-dependent caller untouched.

## Review

The reviews find incomplete crash coverage, a spool race, and duplicate writer ownership.

The final changes resolve the crash and spool race findings.

The stage descriptor isolates the writer ownership dependency.
