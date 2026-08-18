# Goal: land v2, execute the v3 plan

Supersedes the 2026-08-17 v2-preflight goal. Its "no merge to main" rule is
retired: the operator chose **merge #849 first** on 2026-08-18.

## Mission

1. Merge PR #849 (`chore/v2-w4-sweep` -> `main`) - v2 becomes the trunk.
2. Execute `2026-08-18-v3-events-and-sql-models-plan.md` phase by phase, on
   `main`, one PR per slice.

## State (2026-08-18)

- Sweep: done except #833/#839 (tiered publish), #836 (Homebrew), #838
  (prompts MCP), #841 remainder (folds into Phase 3). These become normal
  issues on main; none block v3 phases.
- v3 plan Phase 0: #837 done (#872), #869 done (#873). Remaining: golden
  corpus fixture + replay test.
- Decisions locked: #868 proposals AUTO-MINT behind 3 guards (corroboration
  +/-25% vs raw cache-token deltas, recurrence >=2 windows, >=$5/wk + cap 3
  open); trio order #869 -> #867 -> #868.

## Queue (in order)

1. Merge #849; verify main CI + staging deploy before calling it landed.
2. Phase 0 remainder: golden corpus fixture + replay test.
3. #867 attribution fields (camelCase `attributionSkill`/`attributionAgent`,
   `cache_miss_reason` is an OBJECT, `api_error_status`; backfill via
   `--reparse=claude`).
4. Phase 1: napi driver spike - GATE: embeds in the compiled binary, else
   stay FFI and skip to Phase 2.
5. Phase 2: NDJSON spool + batch writers (explicit `columns=`, inference
   banned).
6. Phase 3: derives -> SQL models, worst `self_ms` first, shadow-run
   row-diff before each swap; then #868 lens (auto-mint, corroborated).
7. Phase 4: events as merge contract; Phase 5: learning layer - ship-gate:
   beat the regex baseline on held-out labels.

## Rules (carried over)

- One PR per issue/slice, worktree per branch, `bun install` first.
- Local gates before push: `bunx tsc --noEmit -p tsconfig.json` AND
  `bun run typecheck` (filter `rg -v ' (warning|message) TS'`), full
  `bun test` with `AX_DUCKDB_DYLIB` + `AX_DUCKDB_REQUIRE_FTS=1` + temp
  `AX_DATA_DIR`. Known-exempt: 4 studio-desktop electron env failures.
- Verify locally, `--squash --admin` merge on green; CI only gates
  workflow-file edits.
- Kill criteria + open questions live in the v3 plan; retract in place when
  a claim dies.

## Open questions (operator)

- Phase 1 spike outcome decides driver strategy (plan Q2).
- Content-hash watermark migration: eager vs lazy (plan Q3).
- Studio Live progress granularity for single-statement derives (plan Q4).
