# Architecture Deepening - Master Plan

> **For agentic workers:** This is the orchestration index. Each phase has its own
> detailed plan (linked below) executable via superpowers:subagent-driven-development
> or superpowers:executing-plans. Execute phases per the track/merge rules here.

**Goal:** Turn five shallow seams into deep modules: query layer, CLI dispatcher,
dashboard route table, parser normalization, signal derivation core. Testability and
AI-navigability are the payoff.

**Source:** /improve-codebase-architecture review (2026-06-10) over CONTEXT.md +
docs/adr/. All five phases verified non-conflicting with existing ADRs
(ADR-0006 stage contract, ADR-0007 live-traces progress, ADR-0008 vendored
live-traces all preserved; phase 4 explicitly stays within-stage).

---

## Phase plans

| # | Plan | Tasks | Scope |
|---|------|-------|-------|
| 1 | [phase1-query-seam](2026-06-10-arch-phase1-query-seam.md) | 6 | Kill SKILL_DETAIL_SQL triplication; `fetch*()` contract codified; cmdStats/cmdUnused SQL → `queries/` |
| 2 | [phase2-cli-command-families](2026-06-10-arch-phase2-cli-command-families.md) | 20 | 5,870-line `cli/index.ts` → 18 family modules; kill string-array round-trip; manifest-derived DB_COMMANDS |
| 3 | [phase3-dashboard-route-table](2026-06-10-arch-phase3-dashboard-route-table.md) | ~8 | 546-line if-chain → typed route table; Schema param decoders; rawRoute escape hatches (SSE/image/ingest) |
| 4 | [phase4-parser-normalization](2026-06-10-arch-phase4-parser-normalization.md) | 9 | 4 remaining parsers → `NormalizedTranscriptBatch` adapters (opencode already converted); statement-parity harness; walkJsonlFiles dedup |
| 5 | [phase5-derive-signals-split](2026-06-10-arch-phase5-derive-signals-split.md) | 6 | derive-signals.ts (1,018 LOC, ~0 tests) → `ingest/signals/{types,core,statements}` + characterization tests |

## Phase 0 - quick wins (do first, one commit, no plan needed)

- Delete `packages/lib/src/bun-platform.ts` (dead - zero callers, verified by grep).
- Gate: `bun run typecheck` green, `bun test packages/lib` green.
- Commit: `chore(lib): delete dead bun-platform re-export`

## Priority + rationale

1. **Phase 1** first - smallest (6 tasks), defines the `fetch*()` query contract
   phases 2 and 3 consume, and touches files both later phases also touch
   (`cli/index.ts`, `dashboard/server.ts`, `dashboard/triage.ts`). Landing it first
   converts later conflicts into clean rebases.
2. **Phase 4** and **Phase 5** - independent ingest-side tracks; start in parallel
   with phase 1 immediately. Highest defect-surface payoff per LOC (signal quality
   feeds Retrospective Candidates; parser seam makes harness #6 cheap).
3. **Phase 2** and **Phase 3** - after phase 1 merges. They touch disjoint dirs
   (`cli/` vs `dashboard/`) and can run in parallel worktrees.

## Tracks (parallel execution)

```
Track A: Phase 0 → Phase 1 ──→ Phase 2 (cli/)
                          └──→ Phase 3 (dashboard/)   [parallel with 2]
Track B: Phase 4 (ingest parsers + normalized/)        [starts immediately]
Track C: Phase 5 (ingest/signals/ + derive-signals.ts) [starts immediately]
```

One worktree + one PR per phase. Tracks B/C touch `apps/axctl/src/ingest/` but
disjoint files (parsers + `normalized/transcripts.ts` vs `derive-signals.ts` +
new `signals/`); no shared edits.

## Merge order + conflict hotspots

| Merge order | Conflicts to watch |
|-------------|--------------------|
| 0 → 1 | none |
| 4, 5 (any order, anytime) | none with A-track; none with each other |
| 2 after 1 | `cmdStats`/`cmdUnused` in `cli/index.ts` - phase 1 rewrote their bodies (fetch + format); phase 2 moves them. Rebase phase 2's inventory line ranges after phase 1 lands. |
| 3 after 1 | `dashboard/server.ts` + `dashboard/triage.ts` - phase 1 moved `fetchSkillDetail` out of triage.ts; phase 3's route inventory references the post-phase-1 import sites. |
| 2 ∥ 3 | disjoint dirs; only shared file is `cli/index.ts` importing `serveDashboard` (unchanged by 3). Safe parallel. |

## Execution protocol (every phase)

- Fresh worktree off latest `main` (enforce-worktree hooks block main edits anyway).
- Execute the phase plan task-by-task via superpowers:subagent-driven-development
  (fresh subagent per task) or executing-plans inline. Tasks are commit-sized;
  never batch commits across tasks.
- Gates per task: `bun run typecheck` green; `bun test apps/axctl` (or scoped path)
  green. The literal `bun test` shell string is blocked by a global hook - use the
  wrapper documented in each phase plan (`/tmp/rt.sh`).
- Never `git add -A` (repo staging rule); stage only files the task names.
- DB-backed smoke steps need local SurrealDB up (`127.0.0.1:8521`); never run bare
  `ax ingest` during phases 4/5 verification while ax-watch daemon is live
  (re-ingest race) - use the fixture/snapshot harnesses in the plans instead.
- PR per phase; run /code-review before merge.

## Cross-phase contracts (lock these; planners already aligned)

- **Query module contract** (phase 1, consumed by 2+3): module in
  `apps/axctl/src/queries/<name>.ts` exports params type + Row types + SQL const
  (for tests) + `fetch<X>(): Effect<Result, DbError, SurrealClient>`; two-tier:
  `defineQuery`/`runQuery` for single statements, `fetch*` for orchestrations.
- **CLI handler contract** (phase 2): handlers take typed option objects; the only
  sanctioned string-args exception is `cmdIngest`/`cmdIngestHere` (runIngest parses
  downstream).
- **Route contract** (phase 3): `jsonRoute` (decoder → Effect handler → typed
  dashboard-types payload) / `rawRoute` (Request→Response escape hatch);
  IngestStreamBus seam untouched.
- **Parser contract** (phase 4): parser = raw transcripts → `NormalizedTranscriptBatch`
  (+ documented parser-specific extras: token-usage rows, claude hooks,
  relateInvocations); statement parity proven via sorted-multiset diff harness with
  the 5-entry documented delta ledger (D1–D5).
- **Signals core contract** (phase 5): evidence rows in → signal records + edge
  specs out; golden SurrealQL strings pin write-parity; the dash-strip vs
  `turnRecordKey` non-unification is deliberate (record-key stability).

## Known open questions (resolve during execution, none blocking)

- Phase 2: typed options contract for `runIngest` later? (out of scope now)
- Phase 4: keep claude's 7 OTLP write spans vs 1 batch write - decide at task; add
  ADR-0012 if the seam decision feels durable.
- Phase 3: `Schema.FiniteFromString` stricter than legacy `Number()` on exotic
  inputs - accept stricter, note in commit.

## End-state acceptance

- `cli/index.ts` ≤ ~450 lines; `dashboard/server.ts` ≈ 250 lines; zero duplicate
  skill-detail SQL; 4 parsers behind `NormalizedTranscriptBatch`; signals core has
  fixture tests for all 8 derivation rules + rule 0.
- `bun run typecheck` + full `bun test` green on every merge.
- No behavior change anywhere except the documented delta ledgers (phase 3: six
  behavioral deltas, each tested; phase 4: D1–D5).
