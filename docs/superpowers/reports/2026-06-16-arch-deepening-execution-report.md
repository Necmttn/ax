# Arch-Deepening Execution Report — 2026-06-16

Overnight execution of the 9-candidate goal package
(`docs/superpowers/plans/2026-06-16-arch-deepening-goal-package.md`).
A1 was split into A1+A2, so **9 work-packages → 9 PRs**, all opened, each on
its own worktree+branch with TDD and a `bun test` + `bunx tsc --noEmit` gate.

## Shipped (all 9)

| Pkg | PR | Base | CI | Headline |
|-----|-----|------|----|----------|
| A1 recall contract | #441 | main | ✅ CLEAN | shared `normalizeRecallParams`/`isEmptyRecallQuery`; HTTP/MCP/CLI delegate; per-rule parity test; MCP now echoes RAW q (documented) |
| A2 cost-window | #446 | main | ✅ CLEAN | `clampInt` + `COST_DEFAULT_WINDOW_DAYS` single-sources the 5 dup 14s; `sqlWindowDays` kept as injection guard |
| B MCP factory (tier-2) | #450 | **arch/a1-recall-contract** | ⏳ settling | `defineMcpTool` zod `z.infer` factory; all 17 tools; TS2589 cast removed from server.ts |
| C parser toolkit | #445 | main | ✅ CLEAN | shared `textFromContent` (3 copies) + `classifyUserText`/`message-kind.ts`; `outputText` dropped |
| D otel signal-flow | #447 | main | ✅ CLEAN | `signal.ts`/`signals.ts` + `SIGNALS` registry kills 3-way if; fail-open centralized; key-gaps filed separately |
| E CLI table | #449 | main | ✅ CLEAN | pure `renderTable` column-builder; role-format canary + ax-cost/ax-dispatches migrated golden-byte-identical |
| F graph toolkit | #448 | main | ✅ CLEAN | `stringFieldOr` + minimal value-form primitives; 4 drifted dup copies → shims; NaN-guard FIX |
| G stage registry | #443 | main | ✅ CLEAN | derive `IngestStageKey` from `ALL_STAGES`; **deps-validity guard** (real dep-drop bugfix) |
| H file-context | #444 | main | ✅ CLEAN | export-in-place 5 fns + `filterSuppressed` (triple-suppression fix) + pure `finalizeInjection`; no folder split |

Aggregate test evidence across packages: repo-wide `bun test` stayed green on
every branch (C reported 4357, F 4375, D 3220, B 3198 pass / 0 fail); every
package gated on `bunx tsc -p apps/axctl/tsconfig.json --noEmit` = 0 errors
(F + A2 also gated packages/lib). Pre-existing parser/otel/cli golden tests
stayed green = no behavior drift.

## Deferred (faithful to spec, not skipped)

- **B tier-1 (Effect-native McpServer via effect/unstable/ai)** — gated on a
  live Claude-Code↔MCP interop spike (tools/list + tools/call + isError
  envelope parity, stdout-is-sacred). NOT autonomously runnable headless.
  Tier-2 (#450) is the shipped safe floor. Run the one-tool (recall) spike
  before deciding whether tier-1 supersedes tier-2.
- **I — derive-stage typed read layer** — DEFERRED per plan (no ADR-0006
  reopen). Ship only the zero-risk dedup if/when the schema-archaeology pain
  is confirmed.
- Filed-not-frozen follow-ups surfaced during D: `metricPointKey` omits
  `agent_name`, `spanKey` is span_id-only (record-id uniqueness gaps);
  malformed-gzip is a pre-existing defect-not-fail-open gap. Pinned by
  characterization tests, left for a separate PR.

## Merge guidance

1. **B (#450) is stacked on A1 (#441)** — merge A1 first, then rebase/merge B
   onto main (or merge A1, retarget #450 base→main).
2. **Latent file overlaps across parallel branches** (resolve at rebase, all
   on different lines so likely auto-merge):
   - `apps/axctl/src/mcp/tools.ts`: A1 (recall tool) · A2 (cost handlers) · B (factory rewrite). B already contains A1; sequence A1→A2→B or rebase B last.
   - `apps/axctl/src/queries/cost-analytics.ts`: A2 (sqlWindowDays L51/101/190) · F (countField adoption L63). Different lines.
   - `apps/axctl/src/cli/commands/ax-cost.ts`: A2 (Flag defaults) · E (table render). Different regions.
3. **Gate the batch on main CI AFTER the last merge** — individually-green
   parallel PRs can break main together (API drift). Do not trust PR-green alone.
4. Merge only at `mergeStateStatus: CLEAN` (#450 was still settling at report time).

## Cleanup

9 worktrees under `.claude/worktrees/arch-*` remain until their PRs merge.
After merge: `git worktree remove .claude/worktrees/arch-<pkg>` per package,
then `git worktree prune`.

## Process note

The 9 packages came from a 45-agent scope+3-review+synth workflow whose reviews
materially corrected the original scopes (B's "duplicates the HttpApi contract"
premise was false; A split; F's CI-gate dropped; G's 31-file sweep demoted).
Executing the *corrected* specs — not the originals — is why every package
landed green on the first pass.
