# Workflow Mining Implementation Plan (#588)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. The final task (B6) is a mandatory verify + dogfood + review + PR gate.

**Goal:** Mine recurring ordered skill-invocation arcs across sessions and propose codifying each as a scaffolded skill - the sequence rung of the directive-mining ladder.

**Architecture:** A pure `mineArcs` detector consumes the existing `WORKFLOW_SESSION_SEQUENCES_SQL` per-session skill stream, emits recurring gapped subsequences, which a derive step turns into `form=skill`/`section="workflows"` proposals on the EXISTING proposal pipeline. `ax directives workflows --emit-brief` surfaces them; accept scaffolds a stub SKILL.md via the existing `improve --auto-scaffold` path. No new tables.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, SurrealDB 3.0+ (`127.0.0.1:8521`), `effect@beta`, bun:test. Spec: `docs/superpowers/specs/2026-06-23-workflow-mining-design.md`.

## Global Constraints

- **No new table.** Workflow proposals reuse `proposal`/`guidance_proposal`/`skill_proposal`; recurrence = `frequency`; discriminator = `section="workflows"` (mirrors A's `section="directives"`).
- **Deref-free queries:** no nested record deref (`out.session`/`in.session`) in an aggregate/WHERE over a large edge set. `WORKFLOW_SESSION_SEQUENCES_SQL` already exists and is the only query needed for the stream - reuse it; do not write a new sequence scan.
- **SurrealDB v3:** no `FROM x AS y` table aliasing (the Milestone A bug); SCHEMAFULL; datetime via Date/`time::now()`. **Run any DB-backed query LIVE before declaring done** - DB-free unit tests miss parse errors.
- **Pure logic separated from Effect/DB wrappers** (testability), mirroring `queries/image-context.ts`.
- **Reuse, don't rebuild:** `acceptProposal({autoScaffold})` for codify, the A brief-renderer pattern for `--emit-brief`, the A `section`-discriminator for list/dojo.
- **Step unit = skills only.** An arc is an ordered list of skill names. No tool-class/episode extraction in v1.
- **Arc bounds:** length 3–6 skills; support ≥ 3 distinct sessions; gapped (same relative order, noise between allowed); maximal arcs only (drop a strict subsequence of an equal-or-higher-support arc); cap candidates (top 50 by support).
- **New subcommand docs gate:** `ax directives workflows` must update `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`, root `CLAUDE.md` (the freshness lint `scripts/check-site-cli-reference.ts` is the gate). `visible-commands.ts` already lists `directives`.
- **Attribution:** none of these are user-shared artifacts - no `Generated with ax` plug.
- **Commits** end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. One PR for #588. No-merge-while-UNSTABLE.
- **Gate dependency:** B is execution-ready but the loop's value is unconfirmed until A's directive proposals get accepted. (Building now is an explicit override - noted, proceeding.)

## File Structure

- `apps/axctl/src/queries/workflow-sequences.ts` - NEW. `buildPerSession` (pure), `mineArcs` (pure), `fetchWorkflowArcs` (Effect, wraps the existing SQL).
- `apps/axctl/src/ingest/derive-proposals.ts` - MODIFY. `deriveWorkflowProposalRows` + `workflowProposals` in `ProposalsStats` + fold into `deriveProposals`.
- `apps/axctl/src/cli/workflows-brief-template.ts` - NEW. `renderWorkflowsBrief` (pure).
- `apps/axctl/src/cli/commands/ax-directives.ts` - MODIFY. add `workflows` subcommand.
- docs: `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`, root `CLAUDE.md`.

---

### Task B1: Per-session reshaper + arc miner (pure)

**Files:**
- Create: `apps/axctl/src/queries/workflow-sequences.ts`
- Test: `apps/axctl/src/queries/workflow-sequences.test.ts`

**Interfaces - Produces:**
```typescript
export interface SeqRow { readonly session: string; readonly skill: string; readonly ts: string | Date; readonly turn_index: number; }
export interface ArcCandidate { readonly steps: readonly string[]; readonly support: number; }

// pure: group rows by session, order by (turn_index, ts), → ordered skill-name lists
export const buildPerSession: (rows: readonly SeqRow[]) => Map<string, string[]>;

// pure: recurring gapped ordered subsequences. length 3..6, support>=3 distinct sessions,
// maximal only, capped to top `limit` (default 50) by support desc.
export const mineArcs: (
  perSession: ReadonlyMap<string, readonly string[]>,
  opts?: { readonly minLen?: number; readonly maxLen?: number; readonly minSessions?: number; readonly limit?: number },
) => ArcCandidate[];
```

- [ ] **Step 1: Write failing tests** → `workflow-sequences.test.ts`

```typescript
import { expect, test } from "bun:test";
import { buildPerSession, mineArcs } from "./workflow-sequences.ts";

test("buildPerSession orders a session's skills by turn_index", () => {
  const rows = [
    { session: "s1", skill: "review", ts: "2026-06-01T03:00:00Z", turn_index: 30 },
    { session: "s1", skill: "plan", ts: "2026-06-01T01:00:00Z", turn_index: 10 },
    { session: "s1", skill: "tdd", ts: "2026-06-01T02:00:00Z", turn_index: 20 },
  ];
  expect(buildPerSession(rows).get("s1")).toEqual(["plan", "tdd", "review"]);
});

test("mineArcs finds a gapped arc recurring across >= minSessions sessions", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "recall", "tdd", "review", "commit"]],     // plan>tdd>review>commit (gapped by recall)
    ["s2", ["plan", "tdd", "review", "commit"]],
    ["s3", ["plan", "tdd", "x", "review", "commit"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  const hit = arcs.find((a) => a.steps.join(">") === "plan>tdd>review>commit");
  expect(hit).toBeDefined();
  expect(hit!.support).toBe(3);
});

test("mineArcs drops a strict subsequence covered by an equal/higher-support superset (maximality)", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review"]],
    ["s2", ["plan", "tdd", "review"]],
    ["s3", ["plan", "tdd", "review"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  // "plan>tdd" (len 2) is below minLen anyway; assert no len-3 fragment duplicates when a superset exists.
  // Here the maximal arc is plan>tdd>review itself; assert it is present exactly once.
  expect(arcs.filter((a) => a.steps.join(">") === "plan>tdd>review")).toHaveLength(1);
});

test("mineArcs drops arcs below support threshold and below minLen", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review"]],
    ["s2", ["plan", "tdd", "review"]],   // support 2 < 3
    ["s3", ["a", "b"]],                    // len 2 < 3
  ]);
  expect(mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 })).toHaveLength(0);
});

test("mineArcs counts a session at most once toward support", () => {
  const per = new Map<string, string[]>([
    ["s1", ["plan", "tdd", "review", "plan", "tdd", "review"]], // arc appears twice in one session
    ["s2", ["plan", "tdd", "review"]],
    ["s3", ["plan", "tdd", "review"]],
  ]);
  const arcs = mineArcs(per, { minLen: 3, maxLen: 6, minSessions: 3 });
  expect(arcs.find((a) => a.steps.join(">") === "plan>tdd>review")!.support).toBe(3);
});
```

- [ ] **Step 2: Run - expect FAIL.** `bun test apps/axctl/src/queries/workflow-sequences.test.ts` (functions not defined).
- [ ] **Step 3: Implement `buildPerSession` + `mineArcs`.**
  - `buildPerSession`: group by `session`; sort each group by `turn_index` then `ts`; map to `skill` strings.
  - `mineArcs`: enumerate candidate arcs by, per session, generating ordered subsequences of length `minLen..maxLen` over that session's skill list (a session "contains" an arc if the arc is a subsequence of the session list - gapped match). Count distinct sessions per canonical arc tuple. Keep arcs with `support >= minSessions`. Apply maximality: remove any arc that is a strict subsequence of another kept arc with `support >= its own support`. Sort by `support` desc, then steps, slice to `limit`. To bound cost, dedupe candidate tuples and skip generating subsequences longer than the session or beyond `maxLen`.
  - Subsequence match helper: `isSubsequence(arc, sessionSkills)` - greedy two-pointer.
- [ ] **Step 4: Run - expect PASS** (5/5).
- [ ] **Step 5: Commit** - `feat(queries): mineArcs recurring skill-arc detector (#588)`

---

### Task B2: DB-backed arc fetch

**Files:**
- Modify: `apps/axctl/src/queries/workflow-sequences.ts` (add `fetchWorkflowArcs`)
- Test: extend `workflow-sequences.test.ts` if a pure reshaper is added; otherwise typecheck-only for the Effect wrapper.

**Interfaces - Consumes:** `WORKFLOW_SESSION_SEQUENCES_SQL` from `apps/axctl/src/queries/workflow.ts` (yields `{ session, skill, turn_index, ts }` rows, already subagent-excluded, `is_first=true`). **Produces:**
```typescript
export interface FetchArcsInput { readonly minSessions?: number; readonly limit?: number; }
export const fetchWorkflowArcs: (input?: FetchArcsInput) =>
  Effect.Effect<ArcCandidate[], DbError, SurrealClient>; // Effect.fn("queries.fetchWorkflowArcs")
```

- [ ] **Step 1: Read** `queries/workflow.ts` (`WORKFLOW_SESSION_SEQUENCES_SQL`, the `W`/weeks window const) and `queries/image-context.ts` (the `Effect.fn` + pure-rollup pattern).
- [ ] **Step 2: Implement `fetchWorkflowArcs`** - `Effect.fn("queries.fetchWorkflowArcs")`: `db.query` the existing `WORKFLOW_SESSION_SEQUENCES_SQL`, coerce rows to `SeqRow[]`, `buildPerSession`, `mineArcs(per, { minSessions, limit })`. Reuse the existing SQL constant; do NOT write a new sequence scan. If the SQL's window is fixed at `W` weeks, that's fine for v1 (note it).
- [ ] **Step 3: Typecheck** (`bun run typecheck` - expect zero `error TS`; pre-existing Effect-LSP `message TS` advisories are not errors).
- [ ] **Step 4: Commit** - `feat(queries): fetchWorkflowArcs over WORKFLOW_SESSION_SEQUENCES_SQL (#588)`

---

### Task B3: Workflow-codification proposals

**Files:**
- Modify: `apps/axctl/src/ingest/derive-proposals.ts`
- Test: extend `apps/axctl/src/ingest/derive-proposals.test.ts`

**Interfaces - Consumes:** `ArcCandidate` (B1), the existing `GuidanceProposalRow`/`buildGuidanceProposalStatements`/`normalizeTitle`/`dedupeSig` patterns, `ProposalsStats`. **Produces:**
```typescript
// pure: arcs → proposal rows. form=skill, section="workflows", frequency=support, stable sig.
export const deriveWorkflowProposalRows: (
  arcs: readonly ArcCandidate[],
  opts?: { readonly minSessions?: number; readonly limit?: number },
) => { readonly rows: ReadonlyArray<SkillProposalRow>; readonly skipped: number };
```
Use the existing per-form proposal-row shape. If directive proposals use `GuidanceProposalRow` with `section`, model the workflow row the same way but `form="skill"` and `section="workflows"`. Title = `"Workflow: " + steps.join(" → ")` (cap length); evidence = support + a sample of session ids.

- [ ] **Step 1: Read** `derive-proposals.ts` - `deriveDirectiveProposalRows` (lines ~131–179), the proposal-row shape, `normalizeTitle`/`dedupeSig`/`proposalKeyFor` (lines ~458–491), `ProposalsStats` (lines ~739–752), and how `section` is set for directives (line ~168). Mirror that structure.
- [ ] **Step 2: Write failing test** → extend `derive-proposals.test.ts`

```typescript
import { deriveWorkflowProposalRows } from "./derive-proposals.ts";

test("deriveWorkflowProposalRows maps arcs to skill/workflows proposal rows", () => {
  const { rows } = deriveWorkflowProposalRows([
    { steps: ["plan", "tdd", "review", "commit"], support: 5 },
    { steps: ["recall", "read", "edit", "test"], support: 3 },
  ], { minSessions: 3 });
  expect(rows).toHaveLength(2);
  expect(rows[0].title).toContain("Workflow:");
  expect(rows[0].title).toContain("plan");
  expect(rows[0].frequency).toBe(5);          // support → frequency
  expect(rows[0].section).toBe("workflows");  // discriminator
  expect(rows[0].form).toBe("skill");
  // stable sig: same arc → same sig
  const again = deriveWorkflowProposalRows([{ steps: ["plan","tdd","review","commit"], support: 5 }]);
  expect(again.rows[0].sig).toBe(rows[0].sig);
});

test("deriveWorkflowProposalRows skips arcs below minSessions", () => {
  const { rows, skipped } = deriveWorkflowProposalRows([{ steps: ["a","b","c"], support: 2 }], { minSessions: 3 });
  expect(rows).toHaveLength(0);
  expect(skipped).toBe(1);
});
```
> Adjust field names (`section`, `form`, `frequency`, `sig`) to the actual proposal-row interface you find in step 1. If directives use `GuidanceProposalRow` without explicit `form`/`section` fields on the ROW (set later in `buildGuidanceProposalStatements`), assert the equivalent the actual code exposes - keep the test asserting real mapped behavior (title, frequency=support, stable sig, threshold skip).

- [ ] **Step 3: Run - expect FAIL.**
- [ ] **Step 4: Implement `deriveWorkflowProposalRows`** + add `workflowProposals: Schema.Number` to `ProposalsStats` + fold into `deriveProposals` (call `fetchWorkflowArcs`, build rows, emit via the existing statement builder; only when arcs exist). Set `section="workflows"` the same way directives set `section="directives"`.
- [ ] **Step 5: Run - expect PASS.** `bun test apps/axctl/src/ingest/` green (no regression; check the proposals-stage test count assertion if any).
- [ ] **Step 6: Commit** - `feat(ingest): workflow-codification proposals (#588)`

---

### Task B4: `ax directives workflows` subcommand + brief

**Files:**
- Create: `apps/axctl/src/cli/workflows-brief-template.ts`
- Modify: `apps/axctl/src/cli/commands/ax-directives.ts`
- Test: `apps/axctl/src/cli/workflows-brief-template.test.ts`

**Interfaces - Consumes:** `fetchWorkflowArcs` (B2), the existing `mine --emit-brief` block in `ax-directives.ts`, `renderDirectivesBrief` as the model. **Produces:** `workflows [--emit-brief] [--days=N] [--json]` subcommand + `renderWorkflowsBrief(arcs, {date, days}): string`.

- [ ] **Step 1: Write failing test** → `workflows-brief-template.test.ts`

```typescript
import { expect, test } from "bun:test";
import { renderWorkflowsBrief } from "./workflows-brief-template.ts";

test("renderWorkflowsBrief lists each arc with steps, support, and a fill block", () => {
  const md = renderWorkflowsBrief(
    [{ steps: ["brainstorming", "writing-plans", "subagent-driven-development", "review"], support: 7 }],
    { date: "2026-06-23", days: 90 },
  );
  expect(md).toContain("# ");                       // header
  expect(md.toLowerCase()).toContain("workflow");
  expect(md).toContain("brainstorming");            // a step
  expect(md).toMatch(/7/);                          // support shown
  expect(md.toLowerCase()).toContain("is_workflow");// fill block
  expect(md.toLowerCase()).toMatch(/skill_name|landing/);
});

test("renderWorkflowsBrief handles empty arc list", () => {
  const md = renderWorkflowsBrief([], { date: "2026-06-23", days: 90 });
  expect(typeof md).toBe("string");
  expect(md.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** `renderWorkflowsBrief` (header + agent task instruction: "is this a workflow worth codifying as a skill? name it" + one row per arc with `steps.join(" → ")` + support + a `is_workflow? · skill_name · landing(skill) · rationale` fill block). Then add the `workflows` subcommand to `ax-directives.ts`: `--emit-brief` writes `.ax/tasks/workflows-<date>.md` (mirror the `mine` emit-brief block), else prints ranked arcs; `--json` emits the arc array. Register the subcommand in the `directives` root's `withSubcommands`.
- [ ] **Step 4: Run - expect PASS.** Typecheck. If a CLI command-list/help test asserts the subcommand set, update it additively.
- [ ] **Step 5: Commit** - `feat(cli): ax directives workflows + brief (#588)`

---

### Task B5: Docs gates

**Files:** `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`, root `CLAUDE.md`.

- [ ] **Step 1:** Add the `workflows` subcommand to the existing `directives` entry in `-cli-reference.data.ts` (`sub: [...,"workflows"]`, document its flags), `docs/cli.md` (under the `ax directives` section), `llms.txt` (the directives task group), and the `### Directive mining` block in root `CLAUDE.md` (one line for `workflows`).
- [ ] **Step 2:** Run `bun scripts/check-site-cli-reference.ts` → PASS; run the VISIBLE_COMMANDS/docs gate test → green. Fix docs until green.
- [ ] **Step 3: Commit** - `docs: ax directives workflows reference + gates (#588)`

---

### Task B6: GATE - verify + dogfood + review + PR

- [ ] **Step 1: Full verify** - `bun test` (repo-wide) + `bun run typecheck` (exit 0; only pre-existing Effect-LSP `message TS` advisories, none in new files). Both green.
- [ ] **Step 2: Live dogfood** (the Milestone A lesson - DB-free tests miss parse errors):
  - `ax directives workflows --emit-brief` against the local graph → open `.ax/tasks/workflows-<date>.md`; confirm it surfaces a *genuine* repeated arc (cross-check a top arc against `ax-extract-workflow` on a known shipped artifact). Note precision; if arcs are noise, raise `minSessions` and document.
  - `ax directives workflows --json` → valid JSON.
  - Run the proposals stage live (`ax ingest --stages=proposals` or a full `ax ingest --since=N`) → confirm `workflowProposals` count > 0 if arcs exist and `ax improve list` / `ax improve recommend` shows a `section="workflows"` proposal without a SurrealQL parse error.
  - `ax improve accept <id> --auto-scaffold` on one workflow proposal → confirm a stub `~/.claude/skills/<name>/SKILL.md` is written; then `ax improve lint` reconciles. (Clean up the scaffolded test skill after.)
- [ ] **Step 3: Final whole-branch review** - dispatch a final reviewer on the strongest model over the merge-base→HEAD package (the `/review-all` equivalent): deref-free audit, SurrealDB-v3 `AS`-alias check across new queries, cross-task integration, and triage of accumulated Minors.
- [ ] **Step 4: PR** - open against `main` with the dogfood evidence (the mined arc + its source sessions, the scaffolded skill stub). Wait for CLEAN merge state.
- [ ] **Step 5:** After merge - remove worktree + local/remote branch; close #588 (auto via "Closes #588").

---

## Self-Review

**Spec coverage:** §3 detection → B1; §3 DB stream → B2; §4 codify proposals → B3; §5 CLI/brief → B4; §5 docs gates → B5; §6 verify+dogfood + §2 live-DB lesson → B6. ✓
**Placeholder scan:** every code step has real test code + impl direction; field-name caveats in B3 point at the actual interface to match (not a placeholder - a grounding instruction). No "TBD"/"handle edge cases". ✓
**Type consistency:** `ArcCandidate {steps, support}` consistent B1→B2→B3→B4; `fetchWorkflowArcs`, `mineArcs`, `buildPerSession`, `deriveWorkflowProposalRows`, `renderWorkflowsBrief` names stable across tasks. ✓
**Read & write coverage (ship-checklist):** write (B1-B3 detector+proposals) ↔ on-demand read (B4 CLI) ↔ agent-facing read (B3 makes them `improve recommend`/dojo proposals for free) ↔ docs (B5). ✓

## Execution Handoff

Execute via **superpowers:subagent-driven-development**: fresh implementer per task, spec+quality review per task, final whole-branch review + dogfood at B6, one PR for #588.
