# spar-for-skills - design

**Date:** 2026-06-16
**Status:** approved (brainstorming) → ready for implementation plan
**Origin:** the resolution of `docs/superpowers/plans/2026-06-16-churn-as-gate-grade-experiment.md`.
That experiment proved the *passive/retrospective* path to "ax = the open-ended verifier" is
dead - skills are installed-then-used, so organic edit→outcome signal does not exist on a single
machine. The only live path is **controlled re-runs**: run the same task twice, changing exactly
one thing - the skill. This spec is that path.

## Goal

Let an operator test a **skill edit** the way SkillOpt's gate demands: the *same task* run under
the *original* skill vs the *edited* skill, all else held fixed, scored on cost/efficiency/repair.
This is deliberate and quota-spending by design (two fresh agent runs per experiment), not a
passive analytic.

## Non-goals (v1)

- **No output-quality metric.** We reuse the metrics `spar` already has (cost, turns, wall,
  repair lines, episodes, landed). Whether the edited skill produced *better work* (vs cheaper
  work) is out of scope; the operator reads the diff and judges. A quality rubric is future work.
- **No statistical averaging.** One run per arm in v1 (noisy, directional). N-run averaging to
  beat per-run nondeterminism is a later `--runs=N` flag.
- **No concurrency.** The skill swap is global (see Mechanism), so an experiment serializes all
  local Claude sessions for its duration. Acceptable for a deliberate, operator-initiated run.
- **No new isolation infra.** See Mechanism - we deliberately do not build config relocation.

## Mechanism: why brief-driven global swap (and not isolation)

We confirmed against the official Claude Code docs (claude-code-guide, 2026-06-16):

- Skill precedence is **Enterprise > Personal (`~/.claude/skills/`) > Project (`.claude/skills/`)**.
  A worktree-local `.claude/skills/<name>/` therefore CANNOT override a user-global skill of the
  same name - personal wins.
- `--add-dir` loads *new* skills from an added dir but still loses to user-level by name.
- `CLAUDE_CONFIG_DIR` is undocumented / unreliable (feature request #25762) - do not build on it.
- Relocating the whole `~/.claude` works but is messy (loses MCP/settings/creds, breaks the run).

Conclusion: the *only* documented way to make a session load an edited version of an existing
user-level skill is to **edit the file at `~/.claude/skills/<name>/SKILL.md`** for the duration of
the run. So spar-for-skills does exactly that, brief-driven, and restores from a snapshot after:

```
snapshot original  →  run arm A (original)  →  swap edited in  →  run arm B (edited)  →  restore original
```

This mirrors the existing spar philosophy ("CLI scaffolds, agent re-runs") and adds zero isolation
code. The global-swap window is the price; it is documented in the brief as a caveat.

## Flow

1. **`ax dojo spar-plan --skill <name> [--session <id> | --sha <sha>]`**
   - Resolve the skill row by name → `dir_path`, read its current `SKILL.md` → snapshot text +
     content hash.
   - Pick the **task**: the most recent session that **invoked OR loaded** the skill (we now have
     both edges - `invoked` and the `loaded` edge from #458), unless `--session`/`--sha` overrides.
     The task = that session's `first_user_message`.
   - Freeze the parent sha for the worktree pin (`<sha>^`, same idiom as code-delta spar).
   - Emit a **skill-spar brief** (see Brief structure) carrying two worktree pin commands, swap
     commands, the original snapshot, and an empty edited-skill slot.

2. **Operator / agent runs two arms** (instructions in the brief):
   - Arm A (baseline): create worktree A at parent sha, run the task there → session A. Original
     skill active (no swap).
   - Fill the edited `SKILL.md` into the brief's slot; run the swap-in command (writes it to
     `~/.claude/skills/<name>/SKILL.md`).
   - Arm B (variant): create worktree B at parent sha, run the *same* task → session B.
   - Run the swap-out command (restores the snapshot to `~/.claude/skills/<name>/SKILL.md`).

3. **`ax dojo spar-score <id>`**
   - Detect the brief kind (skill-spar = has `skill:` frontmatter + two worktrees).
   - Resolve session A from worktree A's cwd and session B from worktree B's cwd (each:
     latest session in that cwd after the brief's `created_at` - reuse `findVariantSession`).
   - Score **B (variant) vs A (baseline)** with the existing pure `scoreSpar`.
   - Stamp both sessions `labels=["spar"]` (reuse `stampSparSession`) so they are excluded from
     behavioral analytics, kept in cost analytics - same as code-delta spar.
   - Write the receipt to `~/.ax/dojo/spar/<id>.md` via `renderSparReport`, with the skill name +
     content-hash delta in the header.

## Components (modular, testable)

All new pure logic is unit-tested; Effect glue reuses existing tested helpers.

- **`resolveSkillSparTask` (Effect, new)** - `(skillName) → { task, baselineSessionId, parentSha }`.
  Composes the skill-id lookup + an "most recent session that invoked-or-loaded this skill" query +
  `findCommitWindow`. Tested with a fake SurrealClient.
- **`captureSkillSnapshot` (Effect, new)** - `(dir_path) → { content, hash }`. Reads `SKILL.md`
  via the platform FS. Trivial; covered by the live smoke.
- **`renderSkillSparBrief` / `parseSkillSparBrief` (pure, new)** - the skill-spar brief format
  (superset of the existing brief: adds `skill`, `skill_dir`, `original_hash`, `worktree_a`,
  `worktree_b`, the snapshot block, the edited-skill slot, swap commands). Fully unit-tested,
  round-trips. Kept as a SEPARATE renderer/parser from the code-delta ones (clear boundary) but
  reuses `scoreSpar`/`SparMetrics`.
- **`scoreSkillSpar` (Effect, new thin)** - resolves A and B sessions, fetches metrics
  (`fetchSessionMetrics`, reused), calls `scoreSpar` (reused), renders the report. The dispatch in
  `spar-score` branches on brief kind.
- **CLI wiring** - `spar-plan` gains `--skill`/`--session` flags; a new internal `cmdSparPlanSkill`.
  `spar-score` gains brief-kind detection. No change to the code-delta path.

## Data / queries

- "Most recent session that used skill X" = union over `invoked` (turn→skill) and `loaded`
  (session→skill) edges, resolved to the owning session, ordered by ts desc, filtered to a
  re-runnable **main** session (reuse the `source = "claude"` filter from `captureBaseline`).
- No schema changes. No new tables. Receipts stay file-based in `~/.ax/dojo/spar/`.

## Error handling

- Unknown skill name → clear error listing close matches (or "run `ax skills` to list").
- Skill has no invoked/loaded history → error: "no task uses this skill; pass `--session`/`--sha`".
- `SKILL.md` not found at `dir_path` (synthetic/plugin skill) → error, refuse to plan.
- `spar-score` when one arm's session is missing (operator hasn't run it) → clear "arm A/B not
  found in <worktree> since <created_at>" message, exit non-zero, no partial receipt.
- The swap commands are emitted as plain shell in the brief; failure to restore is the operator's
  risk - the brief prints the snapshot path so a manual restore is always possible.

## Testing

- Pure: `renderSkillSparBrief`/`parseSkillSparBrief` round-trip; brief-kind detection; `scoreSpar`
  reuse (already covered). Edited-slot-empty and snapshot-missing guards.
- Effect: `resolveSkillSparTask` with a fake SurrealClient (invoked-only, loaded-only, both, none).
- Live smoke: `spar-plan --skill <name>` against the real graph emits a parseable brief.

## CLI reference (docs gate)

- `ax dojo spar-plan --skill <name> [--session <id>|--sha <sha>]` - plan a skill-edit spar:
  snapshot the skill, pick a task that uses it, emit a two-arm brief.
- `ax dojo spar-score <id>` - (extended) score the edited-skill arm B vs original-skill arm A.

## Open questions

None blocking. Deferred: a quality rubric for arm comparison; `--runs=N` averaging; auto-running
both arms (currently agent-driven, matching spar's hybrid model).
