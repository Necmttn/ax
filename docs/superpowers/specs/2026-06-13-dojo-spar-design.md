# ax dojo spar - replay benchmark (one task, one delta, scored)

Date: 2026-06-13
Status: approved design, pre-implementation
Follows: docs/superpowers/specs/2026-06-13-ax-dojo-design.md (dojo core, "Sparring" section)

## Problem

The dojo's most differentiated idea is sparring: take a past landed task, re-run
it with exactly ONE change (a skill on/off, a hook on/off, a prompt tweak, a
model swap), and score the variant against the historical baseline using the
graph's own metrics. The user's transcript history is a benchmark corpus nobody
else has. Today `sparItem()` is a static agenda stub with placeholder commands -
the mechanism doesn't exist.

## Honest shape: a hybrid (CLI scaffolds, agent runs)

You cannot fully automate "re-run a past coding task" in a CLI - the re-run is an
agent doing real work in a worktree. So spar splits cleanly:

- **CLI owns** baseline capture (from the graph), the experiment brief, variant
  scoring, and the receipt. All deterministic, testable, evidence-derived.
- **Agent owns** the re-run: pin a worktree at the baseline's parent SHA, apply
  the ONE delta, do the task. (skill-prose in SKILL.md.)

Two phases, frozen baseline in between:

```
ax dojo spar plan <sha|session>   ->  baseline captured + brief written (~/.ax/dojo/spar/<id>.md)
   [agent: git worktree add ... <parentSha>; apply ONE delta; run the task]
ax dojo spar score <id> [--variant-session=<id>]  ->  baseline vs variant receipt (~/.ax/dojo/spar/<id>-report.md)
```

## `ax dojo spar plan <sha|session> [--json]`

Captures and freezes the baseline.

1. Resolve the window: `findCommitWindow(repoRoot, sha)` (`packages/lib/src/
   git-window.ts`) → parent SHA + predecessor→commit time window. (If a session
   id is passed instead, use it directly + its session's commit if linked.)
2. `listSessionsNear({ from, to, repositoryKey })` (`apps/axctl/src/dashboard/
   sessions-query.ts`) → the landed session for the window. Pick the session
   whose work produced the commit (the most substantive in-window session; if
   ambiguous, the longest by turn_count). Capture its `first_user_message` (the
   task prompt) + `turn_count`, `started_at`/`ended_at` (wall time).
3. Baseline metrics (frozen): `fetchSessionCostMap([sessionId])` (tokens + cost,
   `apps/axctl/src/metrics/cost-estimate.ts`) and `fetchSessionChurnSummary`
   (landed/edit/repair lines, episodes, verification, `apps/axctl/src/metrics/
   session-churn.ts`) for that session. `landed` = produced the commit (true for
   the baseline by construction).
4. Write a `SparBrief` to `~/.ax/dojo/spar/<id>.md` (id = `<shortSha>-<date>`),
   frontmatter + a fenced JSON `baseline` block + prose:
   - the task prompt (verbatim, the agent re-runs this)
   - pin point: parent SHA + the exact `git worktree add .claude/worktrees/
     dojo-spar-<id> -b dojo/spar-<id> <parentSha>` command
   - frozen baseline metrics (tokens, turns, wallMs, repairLines, episodes,
     landed)
   - a **DELTA slot** the agent fills: which single change to test
     (skill/hook/prompt/model) + rationale
5. Print the brief path (or `--json` the SparBrief). cost_class xl: this stages
   an expensive re-run.

## `ax dojo spar score <id> [--variant-session=<id>] [--json]`

Scores the variant the agent produced against the frozen baseline.

1. Load + parse the `SparBrief` (`~/.ax/dojo/spar/<id>.md`) → frozen baseline +
   the spar worktree cwd.
2. Resolve the variant session: `--variant-session=<id>` explicit, else
   auto-find the most recent session whose `cwd` is the spar worktree path and
   `started_at >= brief.created_at` (adapt the `listSessionsNear` query pattern:
   `WHERE cwd = $cwd AND started_at >= $since ORDER BY started_at DESC LIMIT 1`).
   Fail cleanly if none found (the agent hasn't run it yet).
3. Fetch variant metrics (same functions as baseline).
4. `scoreSpar(baseline, variant)` (pure) → per-axis deltas + a verdict:
   - axes: tokens, turns, wallMs, repairLines, episodes, landed(bool)
   - `delta` per axis (variant − baseline) + direction (lower-is-better for
     tokens/turns/wall/repair/episodes; landed must stay true)
   - `verdict`: `win` (primary axis tokens-to-land improved AND still landed AND
     repair not worse), `regression` (landed lost OR clearly worse), else `mixed`
5. Write the spar report receipt to `~/.ax/dojo/spar/<id>-report.md` - a
   baseline | variant | delta table + the tested delta + verdict - and append a
   one-line pointer to the day's dojo report if present. `--json` emits SparScore.

## Module shape

```
apps/axctl/src/dojo/spar.ts
  - SparBaseline, SparBrief, SparVariant, SparScore types
  - scoreSpar(baseline, variant): SparScore                 (pure)
  - renderSparBrief(brief): string                          (pure: md + JSON block)
  - parseSparBrief(content): SparBrief | null               (pure: frontmatter + JSON block)
  - renderSparReport(score, brief): string                  (pure: receipt)
  - captureBaseline(shaOrSession, repoRoot): Effect<SparBrief-without-delta, ...>
  - findVariantSession(cwd, sinceMs): Effect<string | null, DbError, SurrealClient>
  - fetchSessionMetrics(sessionId): Effect<SparBaseline|SparVariant, ...>   (wraps cost + churn + session row)
apps/axctl/src/dojo/spar.test.ts
apps/axctl/src/dojo/paths.ts          # add dojoSparDir + dojoSparBriefPath(id) + dojoSparReportPath(id)
apps/axctl/src/dojo/items.ts          # sparItem() commands -> real `ax dojo spar plan/score`
apps/axctl/src/cli/commands/dojo.ts   # add the spar subcommand(s)
```

Pure cores (`scoreSpar`, `renderSparBrief`, `parseSparBrief`, `renderSparReport`)
unit-tested. Effect glue (`captureBaseline`, `findVariantSession`,
`fetchSessionMetrics`) tested with the fake-SurrealClient harness + fixtures;
end-to-end `spar plan` covered by a live smoke against a real recent commit.

## CLI nesting

`ax dojo` is already a family (agenda/report/draft/outbox). Spar has two phases.
Preferred: 2-level nesting `ax dojo spar plan` / `ax dojo spar score` (a `spar`
subcommand group under `dojo`). The plan verifies Effect `effect/unstable/cli`
supports nesting a `withSubcommands` command inside another `withSubcommands`; if
not, fall back to flat `ax dojo spar-plan` / `ax dojo spar-score`. Runtime: both
need `db` (graph metrics) - extend the dojo db-conditional manifest.

## Safety / scope

- Read-only against the graph; writes only to `~/.ax/dojo/spar/`. The re-run
  itself happens in an agent-created worktree (the CLI never spawns it).
- Frozen baseline: captured once at `plan`, scored against at `score` - the
  comparison can't drift.
- Variant identified by worktree cwd + time; explicit `--variant-session`
  preferred.

## Out of scope (v1) / known caveats

- **Analytics pollution**: variant runs are real sessions and DO count in usage/
  cost/taste analytics. v1 marks them only by worktree cwd; a `session.labels`
  tag to exclude spar traffic is deferred (schema change). Noted in the report.
- **Comparability caveat**: re-running a task is non-deterministic - the variant
  may diverge in scope from the baseline. The receipt reports raw metrics + the
  delta honestly; it does not claim statistical significance from one run. The
  spar campaign (multiple runs, goal-file tracked) is how confidence accrues -
  that's the dojo `/goal` curriculum, not this CLI.
- Cross-harness spar (Claude Code vs Codex, same task) - deferred.
- Automated worktree creation / re-run - out of scope by design (agent-driven).

## Open questions

- Picking THE landed session when a window has several: longest-by-turns is the
  v1 heuristic; a commit→session link (if one exists) would be exact - check
  whether `changeset`/commit rows reference a session.
