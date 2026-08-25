# Goal: ax backlog burn-down + standing churn loop

Tracking issue: #1051. Created 2026-08-25.

## Objective

Burn down the open backlog AND stand up a repeatable loop so quality keeps
rising between feature waves. This is not a finite epic - it is the operating
cadence the fleet runs whenever no larger feature is claimed. "Done" is a
healthy queue (no stale-arch issues, no unaddressed follow-ups older than a
wave, every merged fix verified), not an empty one.

## The loop (the "keep iterating" engine)

One pass, repeated:

1. **Inventory** - `gh pr list` + `gh issue list`. Group new arrivals into the
   tracks below. Retarget/close anything stale (see Track E rule).
2. **Scope** - for any non-trivial issue, run an independent codex pass
   (`codex exec -s read-only`) to validate the claimed root cause against real
   code and surface hidden traps/dependencies BEFORE dispatch. Cheap, and it has
   already reshaped plans here (#939 depends on #1011; #1011 was a real
   collision, not designed re-emission).
3. **Dispatch** - one issue → one `bun run wip claim <n> fix` worktree → one
   sonnet implementer with a self-contained brief (exact files, fix, tests,
   verify commands, stop conditions). Independent slices run in parallel.
4. **Verify (self, not the subagent's word)** - re-read each diff; re-run the
   touched suites + the repo gates (below). Expect ~one real defect per
   delegated phase.
5. **Merge** - squash-merge on green. Admin-merge only for locally-verified
   changes on a current branch; let full CI `verify` gate any change touching
   the ingest classifier, a shared cache table, or a data migration.
6. **Release** - merges accumulate into the release-please PR; merge it to cut a
   version once a wave lands.
7. **Refill** - the continuous-discovery arm (Track G) feeds new issues back to
   step 1.

### Gates every PR clears
- Repo guards: `check:no-node-fs`, `check:timestamp-cast`, `check:raw-numeric-cast`.
- `#893` write-contract tests when touching cache tables
  (`stage/table-writes.test.ts` + `table-writes.behavior.test.ts`).
- Full CI `verify` (repo-wide `bun test` + typecheck) for: ingest classifier
  changes, shared-table writes, destructive migrations. Touched-suite-only is
  NOT sufficient there (a stale-branch date-rot and a classifier consumer have
  both slipped past local runs).
- Worktree isolation; one branch per issue; `git -C`, never `cd && git`.
- Destructive migrations: version-marked, idempotent on crash, wipe-before-replay,
  live-file-only (published snapshot never shows mid-migration state) - see the
  #1011 cutover as the reference shape.

## Tracks

### Track A - ingest reliability & performance (highest leverage)
The ingest path is where wrong answers hide and cost accrues.
- **#917** bun SIGSEGV (~14GB) on full `--reparse=claude` - sibling of the
  merged #1043; apply the same session-chunking to the reparse path, find any
  other unbounded materialization.
- **#771** one unreadable spool/JSONL file `Effect.die`s the whole pipeline -
  degrade to a failed stage + warning; audit all `Effect.die(PlatformError)`
  sites (pattern also in codex.ts).
- **#839** publish rewrites the entire DB (4.94 GB / 22s) every run - dominates
  warm incremental. **#833** snapshot published only at end (time-to-first-value
  == whole run). **#865** `ingest_stage` records wall-clock, not self-time
  (#841's surviving half). These three are the warm-ingest cost story; scope
  together.
- **#684** pi `producedCommits=0` despite real commits (`cwd??null`).
- **#720** staleness probe orders by `started_at` but reports `ended_at`.
- **#779** `agent_event.raw` dead weight (watermark-skipped files keep raw
  forever). **#945** turn-grain blind spots (pi writes no `turn_token_usage`;
  codex turn/session grains disagree 3.3x).
- **#953** spool scratch dirs leak raw turn text on stage failure.
  **#952** clone-guard hardening (post-clone WAL re-check, mtime grain).
- **#769/#770/#773/#778** otlpd spool: re-tail growing files, pruned-file
  watermark leak, receiver hardening, 30d-retention-vs-all-time doc drift.

### Track B - cost / lens correctness
Wrong numbers are worse than no numbers.
- **#939** corroboration tautology - UNBLOCKED now #1011 merged. Corroborate the
  ingest price against OTLP per-root-session cost (recursive lineage), count
  only roots with both values, share one `relativeCostDelta` helper between the
  guard and the CLI, drop the exact-equality heuristic. Model-version bump =
  full ledger rebuild.
- **#945** (also Track A) - the grain-disagreement is a cost-accuracy issue.

### Track C - surfaces & MCP
- **#838** expose `prompts` as an MCP tool - UNBLOCKED now #828 merged; small.
- **#1047** `ax prompts` legacy clause applies claude/codex rules to ALL sources;
  make it source-specific (full rules only for claude/codex).
- **#688** large `--json` truncates mid-stream when piped.
- **#767** `ax sql` + agent-accessible playbooks (feature, needs its own design;
  prerequisite is per-column `COMMENT ON` so agent SQL stays honest - #869).
- **#716/#717** authorize `/api/image` from the ingested graph, not a static
  allowlist (security).

### Track D - distribution & upgrade path
- **#675** upgrade-in-place broken: schema self-heal is all-or-nothing, derive
  stages crash on pre-existing data. High user impact - a broken upgrade looks
  like a broken product.
- **#796** ~25% of transcripts never land on some machines; full ingest exits 0
  moving zero (linux). Confirmed for codex forks; the claude/pi half needs the
  reporter's diagnostic re-run.
- **#836** Homebrew tap. **#708/#714** wire the last CI gates
  (`check:harness-docs` drift, the 5th e2e suite).

### Track E - stale cleanup (verify, then close)
Rule: open the artifact before declaring it dead. Each of these references the
removed SurrealDB / `ax serve` daemon; confirm against current `main` (grep the
named symbol), then close with a one-line reason or re-scope to the DuckDB world.
- **#599** SMAppService daemon - tracking issue for PR #604, already closed as
  obsolete; almost certainly close.
- **#689** usage derive 300s watchdog "surreal 3.0.4". **#722**
  `superviseReapLoop` (serve daemon). **#690** studio-desktop preload,
  "0.38.0-era". **#618** handoff for `fix/614` studio backend.
- **#786–#791** [v2-duckdb] sub-tasks - DuckDB is on main; some are done. Verify
  each against shipped code before closing.
- **#723/#721/#689** serve/derive-budget/reap follow-ups - re-scope or close.

### Track F - epics & decisions (tracked here, NOT churned in this loop)
Do not fold these into a churn wave; they need their own claim + design.
- **#893** v3 Phase 4 (in-progress, claimed on another host).
- **#649** Team dashboard v1 (in-progress). **#767** `ax sql`. **#593/#640**
  proactive/deterministic routing.
- Maps: #926, #768, #733, #728, #702, #699. Wayfinder: #755, #765, #762.

### Track G - continuous discovery (keeps the queue alive)
The loop starves without new, evidence-backed issues.
- **Dogfood** the CLI each wave; file what breaks (this is how #1043 and the
  dojo fixes surfaced).
- **Bug-hunt sweeps** (the #926 pattern): parallel adversarial readers over a
  subsystem → verified findings → issues.
- **Dojo** (`ax dojo agenda`) burns surplus quota on self-improvement and mints
  proposals; triage via `ax improve list`.
- **Retro → proposal** loop on notable sessions.

## Sequencing (waves)

- **Wave 1 - quick unblocked wins:** #838, #1047, #771, #939. Small, self-
  contained, mostly one-file. Land + release.
- **Wave 2 - warm-ingest cost:** #839 + #833 + #865 together; then #917.
- **Wave 3 - stale cleanup:** Track E verify-and-close pass (cheap, shrinks the
  board and removes false signal).
- **Wave 4 - upgrade/distribution:** #675, #796, #836.
- **Continuous:** Track G runs alongside every wave.

Waves are ordered by leverage-per-effort, not rigidly; pull any unblocked
Track-A/B/C item forward when a wave has spare parallelism.

## Definition of done (per wave) / health signals
- Every merged fix: verified locally + through the required gate, closed with the
  PR, released.
- Board health: no open [v2-duckdb]/serve/surreal issue left unverified; no
  follow-up older than two waves without a decision; `ax otel`, `ax cost cache`,
  `ax dispatches` read sane on the maintainer's own store.
- The loop is "done" for a session when the claimed wave lands green and the
  release PR is merged - then it repeats.

## Unresolved questions
1. Release cadence - merge the release-please PR (#1046, v0.42.0) per wave, or
   batch several waves per release?
2. Stale cleanup (Track E) - close on the maintainer's judgment, or open a
   single "verify+close" batch PR/comment thread for a human sign-off first?
3. `ax sql` (#767) - in scope for this loop as a designed feature, or parked
   under Track F until the `COMMENT ON` prerequisite (#869) ships?
4. Parallelism budget - how many concurrent implementer worktrees per wave
   before the shared main-merge gate becomes the bottleneck?
