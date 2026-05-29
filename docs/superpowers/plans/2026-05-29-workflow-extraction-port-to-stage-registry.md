# Port workflow-extraction-frictions branch to new StageRegistry

> Source: `worktree-workflow-extraction-frictions` (37 commits, 17 plan tasks + 11 review fixes, 1138 tests, all green on the worktree). Live-DB smoke test confirmed R1 + R5 + R11. Attempted merge into `main` (2026-05-29) aborted: 5 conflicting files, of which the ingest pieces clash with main's StageRegistry refactor (commit `bded64b` deleted legacy `INGEST_STAGE_DEPS` path).
>
> See `docs/superpowers/plans/2026-05-28-workflow-extraction-frictions.md` for the original plan + decisions.

**Goal:** Land everything from the worktree branch onto `main` after main's stage-registry refactor.

**Scope strategy:** Each phase produces an independently mergeable commit on a fresh branch `feat/workflow-extraction-port-2026-05-29` (or similar). Land orthogonal CLI additions first (clean merge); port ingest pieces to the new pattern last.

---

## Frictions to expect

| # | Friction | Evidence |
|---|---|---|
| F1 | `INGEST_STAGE_DEPS` map deleted on main; my P3.1 added `"invoked-positions"` to it. | `git show bded64b` removed `pipeline.test.ts` + reduced `pipeline.ts` to a re-export. |
| F2 | My R7 `runIngestCore` built on legacy stage map; main's `cmdIngest` uses `StageRegistry` service + `IngestContext`. | `git show main:src/cli/index.ts` line 346-450. |
| F3 | My P3.2 wired `relateSkillRoles` inside legacy `ingestSkills()` body; main reshaped `skills.ts` into a `StageDef` with `@stage` annotation. | `git show main:src/ingest/skills.ts` - top-level JSDoc + `skillsStage` export. |
| F4 | My R10 used ADR `0006`; main commit `5663006` freed 6-8 for in-progress drafts. | `docs/adr/0006-typed-stats-as-ingest-stage-contract.md` already untracked on main. |
| F5 | `pipeline.test.ts` deleted on main; my R7 / R11 / P3.1 added asserts there. | `git show bded64b --stat`. |

---

## Phases

### Phase A - Branch + clean CLI additions (low-risk merge)

Land everything from the worktree that doesn't touch the ingest stage machinery. **Estimated: 30 minutes.** Produces a working PR that ships the user-facing surface independently of the ingest refactor.

Files in scope (no main-side conflicts):
- `src/lib/pwd.ts` + test (P1.2)
- `src/lib/git-window.ts` + test (P2.1 helper)
- `src/lib/ids.ts` `recordLiteral` + `safeRecordKey` exports (R8)
- `src/lib/ids.test.ts` (R8)
- `src/lib/role-name.ts` + test (R3 validators)
- `src/cli/output.ts` `wantsJson` + `catchDbErrorAndExit` (R8)
- `src/cli/output.test.ts`
- `src/cli/skills-classify.ts` + template + tests (P3.3)
- `src/cli/skills-tag.ts` + test (P3.4)
- `src/cli/skills-lint.ts` + test (P3.5)
- `src/cli/skills-weighted-format.ts` + test (P3.6 renderer)
- `src/cli/session-show-format.ts` + test (P2.2 renderer)
- `src/cli/role-format.ts` + test (P3.7 renderer)
- `src/dashboard/sessions-query.ts` + test (P2.1 + R11)
- `src/dashboard/session-show.ts` + test (P2.2)
- `src/dashboard/skills-weighted.ts` + test (P3.6)
- `src/dashboard/role-queries.ts` + test (P3.7)
- `src/dashboard/recall.ts` - `fetchRecall` extended with `sources` + `scope` (P1.6 + R1 + R5)
- `src/dashboard/recall.commit.test.ts` (P1.6)
- `src/lib/shared/dashboard-types.ts` - `RecallCommitHit`, `RecallSkillHit`, widened `RecallResponse` (P1.6 + R5)
- `src/lib/transcript-locator.ts` `encodeClaudeProjectSlug` (P1.3 helper) + test
- `schema/schema.surql` - commit FTS index (P1.5), role + plays_role tables + invoked position fields (P3.1, schema-only - runtime use comes in Phase B)
- `schema/schema.test.ts` (P1.5 + P3.1)
- `skills/ax-extract-workflow/SKILL.md` (P4.1)
- `skills/setup/SKILL.md` (P4.2)
- `README.md` CLI shape additions (R6)
- `docs/adr/0009-skill-plays-role-relation.md` - **renamed from 0006**, see F4

Plus `src/cli/index.ts` ADDITIONS only (not the cmdIngest mods):
- New `recall` flags (`--sources`, `--scope`)
- New `sessionsCommand` with `here|around|near|show` subcommands
- New `skills` subcommands (`classify|tag|lint|weighted|by-role|roles`)
- New top-level `roles` command
- `parseSourcesFlag`, `resolveScope` helpers

**Conflict expected:** `src/cli/index.ts` will conflict on imports + on `withDb` map. Resolve by accepting both halves - main's new imports + my new commands. Main's `cmdSearch`/`cmdTaste` etc. unchanged on my side.

**Tests after Phase A:** the new CLI commands work; `ax ingest here` still missing (Phase C); `ax skills weighted` works (P3.6 query is pure SurrealQL, doesn't depend on stage registry).

**Commit message:** `feat: workflow extraction CLI surface (sessions, recall sources/scope, skills classify/tag/lint/weighted/by-role, roles)`

### Phase B - Port `invoked-positions` to StageRegistry pattern

Adapt P3.1 stage to the new architecture. **Estimated: 45 minutes.**

Steps:
1. **Read** `src/ingest/skills.ts` (main version) to learn the canonical pattern: `@stage` JSDoc, `<Name>Key = Schema.Literal("<key>")`, `<name>Stage: StageDef<S, R>` export, deps via `Schema.Array(Schema.String)`.
2. **Rewrite `src/ingest/backfill-invoked-positions.ts`:**
   - Add `@stage invoked-positions` JSDoc with `@rationale`, `@inputs`, `@outputs`, `@order` (place after `subagents`, before `signals`).
   - Export `InvokedPositionsKey = Schema.Literal("invoked-positions")`.
   - Define `InvokedPositionsStats extends BaseStageStats` with `backfilled: int`, `sessions: int`.
   - Wrap existing `backfillInvokedPositions()` body in `invokedPositionsStage: StageDef<InvokedPositionsStats, SurrealClient>`.
   - Set `meta.deps = ["claude", "codex", "subagents"]`.
3. **Register in `src/ingest/stage/registry.ts`:**
   - Add `InvokedPositionsKey` to the `IngestStageKey = Schema.Union([...])` literal.
   - Add `invokedPositionsStage` to `ALL_STAGES`.
4. **Update `src/ingest/transcripts.ts` + `src/ingest/codex.ts`** at the RELATE-invoked sites - already done in the worktree (`turn_index = ${inv.seq}`). Cherry-pick those two-line additions.
5. **Tests:**
   - Keep the R4 incremental-correctness test logic but adapt the mock harness to provide `IngestContext`.
   - Drop the legacy `INGEST_STAGE_DEPS` stage-count assertions (those tests were deleted on main; don't re-add).

**Commit message:** `feat(ingest): invoked-positions stage in registry pattern (ports P3.1 + R4)`

### Phase C - Reconcile `cmdIngestHere` with `StageRegistry`

Adapt R7 `runIngestCore` to the new ingest CLI shape. **Estimated: 60 minutes.**

Approach:
1. **Read** main's `cmdIngest` (`src/cli/index.ts:346-450`) end-to-end. Note: `selectedStages` is computed by `resolveIngestStages(registry, args)`, the `IngestContext` carries `cwd` + `since` + `debug`, the runner uses `LiveTrace.withTrace`.
2. **Adapt the `here` overrides** - `cmdIngestHere` needs to:
   - Resolve `$PWD` via `resolvePwdRepository()` (Phase A delivered this).
   - Encode the Claude project slug via `encodeClaudeProjectSlug()` (Phase A delivered).
   - Filter `selectedStages` to exclude `codex` by default (`HERE_DEFAULT_STAGES`).
   - Inject per-stage overrides for `claude` (project filter) and `git` (repoPaths).
3. **The new architecture forces a different mechanism for per-stage overrides.** Two options:
   - **(a) Per-stage opts argument** - extend `StageDef.run(ctx)` signature to accept an optional opts bag, plumb the override through. Heavier change.
   - **(b) Custom `StageRegistryLive([...wrappedStages])` per command** - replace the default registry with one where the `claude` and `git` stages have run-functions closed over the per-call project / repoPaths. No signature changes elsewhere.
   - **Pick (b).** Lower blast radius. Document the wrapper as "command-scoped registry override" in the JSDoc.
4. **Run:** `bun src/cli/index.ts ingest here --since=1 --stages=git` against the local DB (worktree smoke-test pattern). Verify ingest completes + repository linking works.

**Commit message:** `feat(cli): ingest here via command-scoped registry override (ports P1.3 + R7)`

### Phase D - Port P3.2 frontmatter role wiring

Adapt the `relateSkillRoles` integration to main's `skillsStage`. **Estimated: 30 minutes.**

Steps:
1. **Diff** the worktree `src/ingest/skills.ts` vs main's. Identify exactly where `relateSkillRoles` was called after `upsertSkillByName`.
2. **Insert** the same call into main's stage body. The skill-role helper itself is unchanged; only the call site differs.
3. **Verify R3 validators** are in place - `validateRoleName` / `validateSkillName` already shipped to `src/lib/role-name.ts` in Phase A.
4. **Tests** - the existing `src/ingest/skill-role.test.ts` doesn't care about the stage-shape; should pass as-is.

**Commit message:** `feat(ingest): emit plays_role edges from frontmatter (ports P3.2 + R3)`

### Phase E - `ax setup` + final polish

Sweep up the remainder. **Estimated: 20 minutes.**

- Confirm `bun scripts/check-cli-reference.ts` passes after Phase A's README updates.
- Update `CLAUDE.md` to mention the new commands (optional but good - was a docs-gap finding).
- Update `docs/insights-cli-reference.md` if it gates anything (it doesn't, but consistency).
- Sweep + commit.

**Commit message:** `docs: polish references for shipped workflow extraction commands`

---

## Out of scope (revisit after the port lands)

- **P1.4 auto-delta ingest on stale** - original plan deferred. Revisit once `ax sessions here` ships in Phase A and we have real-world latency feedback.
- **Live-DB integration tests** for `ax sessions here|near` and `ax recall --scope=here` - current mock tests assert SQL shape only. The worktree smoke-test (this conversation's R1/R5/R11 verification) proved the literal-vs-binding fix; bake a gated `AX_E2E_DB=1` test fixture for regression.
- **CLAUDE.md updates** - current CLAUDE.md doesn't mention any of the new commands. Pure docs hygiene.
- **`fetchSessionDetail.tool_calls`** is currently a count summary, not a per-event stream. P2.2 disclosed this as a deviation; revisit when a per-event query path exists.

---

## Status board

| Phase | Status | Branch |
|---|---|---|
| A | not started | `feat/workflow-extraction-cli-2026-05-29` |
| B | not started | (continue on same branch) |
| C | not started | (continue on same branch) |
| D | not started | (continue on same branch) |
| E | not started | (continue on same branch) |

---

## Source-of-truth

Worktree branch: `worktree-workflow-extraction-frictions` at `.claude/worktrees/workflow-extraction-frictions` (kept on disk for cherry-picking).

Key commits to cherry-pick or port:
- `b979c7b` feat(ingest): F7 subagent repository backfill - applies cleanly if `derive-claude-subagents.ts` unchanged on main.
- `adaca40` + `cfef1f2` feat(lib): pwd resolver - clean.
- `cbed141` feat(schema): commit FTS - clean.
- `c18c9da` + `05619be` + `8656805` feat(recall) - clean, ports as a unit.
- `cac3f5e` + `e7bf082` + `8656805` feat(cli): sessions - clean.
- `bbf40f2` + `07529e0` + `e515314` feat(cli): session show - clean.
- `a8b809c` feat(schema): role + plays_role + invoked position fields - schema half clean (Phase A); stage wiring → Phase B.
- `85e7a27` + `f277171` + `aadbe50` feat(ingest): frontmatter role - Phase D.
- `e448ad9` + `1d68df0` feat(skills): classify - clean.
- `c71ec86` feat(skills): tag - clean.
- `94a9cee` feat(skills): lint - clean.
- `0d44ff4` feat(skills): weighted - clean (pure SurrealQL).
- `7b8559b` feat(roles): read commands - clean.
- `69404ee` + `1b666667` + `22ded59` feat(skill): ax-extract-workflow - clean.
- `061c165` refactor(cli): helpers (R8) - clean.
- `1f557ed` docs(readme): R6 - clean.
- `ef09266` docs(adr): R10 (rename to 0009 - Phase A).
- `ac3880d` fix(backfill): R4 - bundled with Phase B.
- `55db148` fix(recall): R5 + R9 - clean.
- `fa392b1` refactor(cli): R7 runIngestCore - **rewrite for Phase C**, not cherry-pick.
- `40f6a38` fix(sessions): R11 enrichment - clean.

Estimated total: **3-4 hours of focused work** to land cleanly on the new architecture.
