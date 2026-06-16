# spar-for-skills - implementation plan

Spec: `docs/superpowers/specs/2026-06-16-spar-for-skills-design.md`. Execute via
subagent-driven-development. TDD per task; one commit per task. All work in
`apps/axctl/src/dojo/`, extending the existing `spar.ts` machinery (reuse
`scoreSpar`, `SparMetrics`, `fetchSessionMetrics`, `findVariantSession`,
`stampSparSession`, `renderSparReport`). Bun `bun:test`. SurrealDB v3 idioms.

Ordering follows the dependency chain: pure brief format → resolve task (Effect)
→ plan CLI → score (Effect) → score CLI dispatch → docs.

---

## Task 1 - Skill-spar brief format (pure)

**Files:** new `apps/axctl/src/dojo/skill-spar.ts`, new `skill-spar.test.ts`.

Add the skill-spar brief type + pure render/parse, kept SEPARATE from the
code-delta brief in `spar.ts` (clear boundary) but reusing `SparMetrics` for the
two arms' baseline shape is NOT needed here - a skill-spar brief has no frozen
baseline metrics (both arms run fresh). It carries:

- frontmatter: `id`, `created_at`, `kind: skill`, `skill` (name), `skill_dir`
  (dir_path), `original_hash`, `parent_sha`, `worktree_a`, `worktree_b`,
  `baseline_session` (the session the task was drawn from, for reference).
- `## Task` - the prompt.
- `## Worktrees` - two `git worktree add` commands (arm A, arm B), both pinned
  to `parent_sha`, branches `dojo/spar-<id>-a` / `-b`.
- `## Original skill (snapshot)` - a fenced block with the original SKILL.md, and
  the absolute snapshot path the swap-out restores from.
- `## Swap commands` - swap-in (write edited slot → `<skill_dir>/SKILL.md`) and
  swap-out (restore snapshot) shell blocks.
- `## Edited skill` - a fenced slot the agent fills (placeholder when empty).
- `## How to run` - the two-arm sequence + the concurrency caveat.

Provide:
- `interface SkillSparBrief` (typed fields above + `editedSkill: string` filled
  by agent, `originalSkill: string`).
- `renderSkillSparBrief(brief, { worktreeAAbs?, worktreeBAbs?, snapshotPathAbs? })`.
- `parseSkillSparBrief(content): SkillSparBrief | null` (round-trips render).
- `isSkillSparBrief(content): boolean` - kind detector (`kind: skill` frontmatter),
  used by `spar-score` dispatch.

**Tests:** render→parse round-trip (empty edited slot → `editedSkill === ""`);
filled edited slot round-trips; `isSkillSparBrief` true for skill brief, false
for a code-delta brief and for garbage; missing required frontmatter → null;
CR/LF in fields can't break a line (reuse the `oneLine` guard idiom from spar.ts).

**Done when:** all pure tests pass, `bun run typecheck` clean.

---

## Task 2 - Resolve the skill-spar task (Effect)

**Files:** extend `apps/axctl/src/dojo/skill-spar.ts`, tests in `skill-spar.test.ts`.

Add `resolveSkillSparTask(skillName, repoRoot, repositoryKey, opts?)` returning
`{ task, baselineSessionId, parentSha, skillDir, originalSkill, originalHash }`,
where `opts` may carry an explicit `sessionId` or `sha` override.

Logic:
1. Look up the skill row by name → `id`, `dir_path`. Error if unknown
   (`SparCaptureError` style) or synthetic (`dir_path === "(synthetic)"`).
2. Read `<dir_path>/SKILL.md` via `FileSystem` → `originalSkill` + `originalHash`
   (hash via `Bun.hash` hex, matching skill-upsert's content_hash style is NOT
   required - any stable hash is fine for display).
3. Pick the task session:
   - if `opts.sessionId` → that session;
   - else if `opts.sha` → reuse `captureBaseline`'s window→highest-turn main
     session pick (factor the shared bit or call a small helper);
   - else → most recent MAIN session (`source = "claude"`) that **invoked OR
     loaded** the skill. Union query over `invoked` (turn→skill, `in.session`)
     and `loaded` (session→skill, `in`), resolve to session, filter to main,
     order ts desc, take 1. Error if none: "no task uses this skill; pass
     `--session`/`--sha`".
   - task = session's `first_user_message`.
4. `parentSha` from `findCommitWindow`/`git rev-parse <sha>^` as in
   `captureBaseline` (for the default/`--sha` path, derive the sha from the
   chosen session's nearest commit or require `--sha`; KEEP IT SIMPLE - v1: the
   chosen session must map to a sha via the existing window helper, else error
   asking for `--sha`).

Keep the SurrealDB queries deref-light (sibling idioms in `spar.ts` /
`skill-hygiene.ts`). Coerce ids with `type::string`.

**Tests (fake SurrealClient):** invoked-only history resolves a task;
loaded-only history resolves a task; both → most-recent wins; none → typed error;
unknown skill → typed error; synthetic skill → typed error. Mock the FS read for
the snapshot via a Test FileSystem layer or inject the content (prefer a small
seam so the query logic is the unit under test).

**Done when:** tests pass, typecheck clean.

---

## Task 3 - `ax dojo spar-plan --skill` CLI

**Files:** the dojo CLI command module (where `spar-plan` lives - locate it under
`apps/axctl/src/cli/`), tests alongside.

Add a `--skill <name>` mode to `spar-plan` (keep the positional `<sha>` code-delta
mode untouched). Flags: `--skill <name>`, `--session <id>`, `--sha <sha>`.
Mutually-exclusive guard: `--skill` is the skill mode; without it, the existing
behavior. New internal `cmdSparPlanSkill`:

1. Resolve repo root + repository key (reuse however `spar-plan` does today).
2. `resolveSkillSparTask(...)`.
3. Build the `SkillSparBrief` (`id = <skillSlug>-<date>`), write the snapshot file
   to `~/.ax/dojo/spar/<id>.skill.orig.md`, render the brief to
   `.ax/tasks/spar-<id>.md` (match where code-delta spar writes its brief), print
   the path (absolute, clickable).

**Tests:** flag parsing (skill vs sha mode, conflicting flags), and a live smoke
that `spar-plan --skill <name>` against the real graph writes a parseable brief
(guard with skill-existence; skip cleanly if the dev box lacks the skill).

**Done when:** tests pass, typecheck clean, live smoke emits a brief that
`parseSkillSparBrief` accepts.

---

## Task 4 - Score the skill-spar (Effect)

**Files:** extend `apps/axctl/src/dojo/skill-spar.ts`, tests in `skill-spar.test.ts`.

Add `scoreSkillSpar(brief, sinceForChurn)` →
`{ a: SparMetrics, b: SparMetrics, score: SparScore }`:

1. `findVariantSession(brief.worktreeA, createdAtMs)` → session A; same for
   worktree B → session B. Error if either missing (clear "arm A/B not found in
   <worktree> since <created_at>").
2. `fetchSessionMetrics` for A and B (reused).
3. `scoreSpar(a, b)` - A is baseline, B is variant (reused pure core).
4. `stampSparSession` both A and B (reused).

Report rendering: reuse `renderSparReport` but with a skill-aware header (skill
name + `original_hash` → edited, "delta tested: skill edit"). A thin
`renderSkillSparReport(score, brief)` wrapping the shared table is fine.

**Tests (fake SurrealClient + pure):** A/B both present → verdict via scoreSpar;
A missing → typed error; B missing → typed error; report header carries the skill
name. Reuse the spar.test fake-db idiom.

**Done when:** tests pass, typecheck clean.

---

## Task 5 - `ax dojo spar-score` brief-kind dispatch

**Files:** the dojo `spar-score` command module + tests.

In `spar-score <id>`: read the brief, branch on `isSkillSparBrief`:
- skill brief → `scoreSkillSpar` path, write receipt to `~/.ax/dojo/spar/<id>.md`
  via `renderSkillSparReport`, print verdict.
- else → existing code-delta path (unchanged).

**Tests:** dispatch picks the skill path for a skill brief and the existing path
for a code-delta brief (mock the two brief contents); receipt written to the
expected path.

**Done when:** tests pass, typecheck clean; both brief kinds score correctly.

---

## Task 6 - Docs (CLI reference gate)

**Files:** `CLAUDE.md` (Dojo section).

Document `ax dojo spar-plan --skill <name> [--session|--sha]` and the extended
`spar-score` (skill arm-B-vs-A). Note: two fresh runs, global skill swap
(operator-serialized), reuses spar machinery, no schema change. Reference the
spec path.

**Done when:** CLAUDE.md updated; no new-subcommand-docs CI gate failure.

---

## Final

After all tasks: full `bun test apps/axctl/src/dojo apps/axctl/src/cli` +
`bun run typecheck`, dispatch a final whole-implementation review, then
finishing-a-development-branch (PR).
