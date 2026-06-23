# Directive Mining v2 - Implementation Plan (Goal Package)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each **Milestone** ends with a mandatory `/review-all` + dogfood gate - do NOT start the next milestone until the gate passes.

**Goal:** Build the three deferred v2 slices of directive mining - (A) the n-gram-lift local miner [#587], (B) the directive→workflow granularity ladder [#588], (C) the community pattern-contribution layer behind a security redesign [#589] - each shipped with both write (derive/mine) and read (CLI + agent-facing + docs) surfaces, dogfood-verified.

**Architecture:** Everything rides the **existing** mine→propose→accept-brief→reconcile→measure loop (`ingest/derive-proposals.ts` + `improve/`). v1 already flags proactive directive turns into `guidance` proposals (`ingest/directives.ts`, PR #538). v2 adds: a per-user lift table that *ranks* which markers actually lead to captured outcomes (replacing v1's hardcoded regex with learned-per-user signal); a sequence detector that lifts the same loop from single-turn directives to ordered workflow arcs; and a curated+contributed pattern library with a code-only detector registry (data layer never carries SurrealQL). No raw user text ever leaves the machine.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, SurrealDB 3.0+ (`127.0.0.1:8521`, ns=`ax`, db=`main`), `effect@beta` (4.0.0-beta.x), bun:test. Queries are deref-free two-statement joins (`Effect.fn("queries.<name>")`, pure aggregation helper + thin DB wrapper). Briefs emit to `.ax/tasks/<name>-<date>.md`.

## Global Constraints

- **No embeddings** - lexical n-gram + outcome-grounding only (`embedding-clustering-spike` rejected them).
- **No auto-write of directives** - the CLI scaffolds candidates; the agent (judgment) writes via the brief. Mirrors every ax brief loop.
- **Deref-free aggregates** - never nest record derefs in aggregate queries (`out.session` in a `GROUP BY` hangs on ~87k-row edges). Two flat statements, join in JS, denormalize scalars onto the edge.
- **Privacy is the whole game (Milestone C)** - contribute the generalized pattern SHAPE, never the raw turn text. Publish is consent-gated per-change (show exact JSON, one explicit yes). Contributors NEVER submit SurrealQL.
- **SurrealDB v3 SCHEMAFULL** - top-level fields explicit; nested objects JSON-encoded as `string`; datetime fields require JS `Date` via the SDK.
- **New SurrealDB table** must be registered in `SCHEMA_TABLES` (`apps/axctl/src/queries/insights.ts`) or the ingest-dir test fails CI.
- **New `ax` subcommand** must update all four docs gates or CI verify fails: `apps/axctl/src/cli/commands/visible-commands.ts` (`VISIBLE_COMMANDS`), `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts` (`CLI_GROUPS`). Freshness lint: `scripts/check-site-cli-reference.ts`.
- **Attribution** - none of these artifacts are user-shared, so do NOT add the `Generated with ax` plug (it's for shareable artifacts only).
- **Worktree discipline** - one branch per issue; `bun run wip claim <issue#>`; work in the printed worktree. Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **No merge while UNSTABLE** - `gh pr merge` only at mergeStateStatus CLEAN.

## Locked design decisions (resolving the spec's open questions)

- **Q1 confirmation window:** outcome counts if it occurs **same session, forward window ≤ 20 turns** after the candidate turn. Outcome = (a) an `edited` edge to a `~/.claude/**/memory/**` path, (b) a `proposal` flipped to `status='accepted'` whose evidence references the session, or (c) a new file under `~/.ax/hooks/`. Temporal only in v2 (topical match deferred).
- **Q5 schema:** **reuse `proposal`** (it already has `origin`, `frequency`, `baseline`, `status`). Add **one** new table `directive_ngram` (the per-user lift table - a transparency/debug surface, not the directive store). Directives remain `guidance`/`hook`-form proposals. Recurrence = `frequency`. Escalation = `form` transition (guidance→hook) on recurrence threshold.
- **Q3 landing default:** new directive defaults to `guidance` (passive); escalates to `hook` only when recurrence ≥ 3 AND the matched pattern has a groundable detector.
- **Q4 recurrence identity:** same `dedupe_sig` (`form__hash(form:normalizedTitle)`) - already how v1 aggregates. Lift sharpens which turns map to the same title.
- **Milestone C ordering:** security redesign (C0, design-only) → safe consume slice (C1) → detector registry (C2) → contribution behind the redesign (C3) → compile + board (C4). C3/C4 do not start until C0's redesign is reviewed and its blockers are closed.

---

# MILESTONE A - n-gram-lift local miner (#587)

**Outcome of this milestone:** `ax directives mine --emit-brief`, `ax directives list`, `ax directives ngrams` work; an ingest stage refits the per-user lift table each run; directive candidates are ranked by lift (not a static regex); dojo surfaces unconfirmed candidates; the lift table is visible via CLI + MCP. Dogfood: mining the real graph produces a brief whose top candidates are genuine standing-instructions, and `ngrams` shows the user's actual markers outranking filler.

**Write angle:** `directive_ngram` table + `directiveNgramsStage` (refit lift each ingest) + lift-ranked candidate flagging feeding existing `deriveDirectiveProposalRows`.
**Read angle:** `ax directives ngrams` / `list` / `mine` (on-demand), MCP `directives_list` tool + dojo `directives` agenda item (proactive/agent-facing), `improve recommend` (already surfaces the proposals).

## A0 - Claim + worktree

- [ ] **Step 1:** `bun run wip claim 587 feat` - creates `.claude/worktrees/587-feat` on `feat/587-...`. `cd` into it.
- [ ] **Step 2:** Confirm baseline: `bun test apps/axctl/src/ingest/directives.test.ts` passes (v1 detector intact).

## A1 - `directive_ngram` schema table

**Files:**
- Modify: `packages/schema/src/schema.surql` (add table near `proposal`, ~line 1684)
- Modify: `apps/axctl/src/queries/insights.ts` (`SCHEMA_TABLES` - add `"directive_ngram"`)

**Interfaces - Produces:** a `directive_ngram` table keyed by `ngram` (the whole local DB is per-user, so no user column).

- [ ] **Step 1: Add the table DDL** (after the `proposal` block)

```sql
DEFINE TABLE directive_ngram SCHEMAFULL;
DEFINE FIELD ngram        ON directive_ngram TYPE string;
DEFINE FIELD n            ON directive_ngram TYPE int;            -- token count (1..4)
DEFINE FIELD occurrences  ON directive_ngram TYPE int DEFAULT 0; -- turns containing the ngram
DEFINE FIELD outcomes     ON directive_ngram TYPE int DEFAULT 0; -- of those, # followed by a captured outcome
DEFINE FIELD lift         ON directive_ngram TYPE float DEFAULT 0; -- P(outcome|ngram)/P(outcome)
DEFINE FIELD sessions     ON directive_ngram TYPE int DEFAULT 0; -- distinct sessions (sparsity guard)
DEFINE FIELD first_seen   ON directive_ngram TYPE datetime DEFAULT time::now();
DEFINE FIELD last_seen    ON directive_ngram TYPE option<datetime>;
DEFINE FIELD refit_at     ON directive_ngram TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS directive_ngram_uq   ON directive_ngram FIELDS ngram UNIQUE;
DEFINE INDEX IF NOT EXISTS directive_ngram_lift ON directive_ngram FIELDS lift;
```

- [ ] **Step 2: Register table.** In `apps/axctl/src/queries/insights.ts`, add `"directive_ngram"` to `SCHEMA_TABLES`.
- [ ] **Step 3: Verify schema loads** - run the schema-tables-mirror guard test (diffs `SCHEMA_TABLES` against `schema.surql`). Expected: PASS.
- [ ] **Step 4: Commit** - `feat(schema): directive_ngram lift table (#587)`

## A2 - Pure lift computation

**Files:**
- Create: `apps/axctl/src/queries/directive-ngrams.ts`
- Test: `apps/axctl/src/queries/directive-ngrams.test.ts`

**Interfaces - Consumes:** `deriveUserMessageNgrams` tokenizer conventions from `ingest/outcomes.ts` (stop-words, code-block/URL stripping). **Produces:**

```typescript
export interface NgramOutcomeRow {
  readonly ngram: string;
  readonly n: number;
  readonly occurrences: number;   // turns containing ngram
  readonly outcomes: number;      // of those, followed by an outcome within the window
  readonly sessions: number;      // distinct sessions
}
export interface LiftRow extends NgramOutcomeRow { readonly lift: number; }

// baseRate = (total turns with an outcome) / (total turns considered)
export const computeLift = (
  rows: readonly NgramOutcomeRow[],
  baseRate: number,
  opts?: { readonly minOccurrences?: number; readonly minSessions?: number },
) => LiftRow[];
```

- [ ] **Step 1: Write failing test**

```typescript
import { expect, test } from "bun:test";
import { computeLift } from "./directive-ngrams.ts";

test("lift ranks outcome-leading ngrams above filler", () => {
  const rows = [
    { ngram: "remember to", n: 2, occurrences: 10, outcomes: 8, sessions: 6 },
    { ngram: "can you",     n: 2, occurrences: 40, outcomes: 4, sessions: 20 },
  ];
  const out = computeLift(rows, 0.1, { minOccurrences: 5, minSessions: 3 });
  expect(out.find((r) => r.ngram === "remember to")!.lift).toBeCloseTo(8.0, 1); // (8/10)/0.1
  expect(out.find((r) => r.ngram === "can you")!.lift).toBeCloseTo(1.0, 1);     // (4/40)/0.1
  expect(out[0].ngram).toBe("remember to"); // sorted desc by lift
});

test("sparsity guard drops ngrams below thresholds", () => {
  const rows = [{ ngram: "one off", n: 2, occurrences: 2, outcomes: 2, sessions: 1 }];
  expect(computeLift(rows, 0.1, { minOccurrences: 5, minSessions: 3 })).toHaveLength(0);
});

test("baseRate of zero yields zero lift, never NaN/Infinity", () => {
  const rows = [{ ngram: "x y", n: 2, occurrences: 5, outcomes: 0, sessions: 3 }];
  expect(computeLift(rows, 0, { minOccurrences: 5, minSessions: 3 })[0].lift).toBe(0);
});
```

- [ ] **Step 2: Run - expect FAIL** (`computeLift` not defined). `bun test apps/axctl/src/queries/directive-ngrams.test.ts`
- [ ] **Step 3: Implement**

```typescript
export const computeLift = (rows, baseRate, opts = {}) => {
  const minOcc = opts.minOccurrences ?? 5;
  const minSess = opts.minSessions ?? 3;
  const safeBase = baseRate > 0 ? baseRate : 0;
  return rows
    .filter((r) => r.occurrences >= minOcc && r.sessions >= minSess)
    .map((r) => {
      const pOutcome = r.occurrences > 0 ? r.outcomes / r.occurrences : 0;
      const lift = safeBase > 0 ? pOutcome / safeBase : 0;
      return { ...r, lift };
    })
    .sort((a, b) => b.lift - a.lift || b.occurrences - a.occurrences || a.ngram.localeCompare(b.ngram));
};
```

- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(queries): pure n-gram lift computation (#587)`

## A3 - DB-backed lift query (deref-free)

**Files:**
- Modify: `apps/axctl/src/queries/directive-ngrams.ts` (add the Effect-wrapped fetch + a pure `tallyNgramOutcomes` reshaper)
- Test: extend `directive-ngrams.test.ts`

**Interfaces - Produces:**

```typescript
export interface FetchLiftInput { readonly sinceDays: number; readonly windowTurns?: number; readonly limit?: number; }
export const fetchDirectiveLift: (input: FetchLiftInput) =>
  Effect.Effect<LiftRow[], DbError, SurrealClient>; // Effect.fn("queries.fetchDirectiveLift")
```

**Query design (two flat statements, join in JS - NO nested derefs, model on `queries/image-context.ts`):**
- Statement 1: user turns in window - `SELECT type::string(id) AS id, type::string(session) AS sid, text_excerpt, ts FROM turn WHERE role = 'user' AND ts > time::now() - <N>d AND source != 'claude-subagent'`.
- Statement 2: outcome markers - union of three flat sub-selects into `{ sid, ts }` rows: `edited` edges where `absolute_path_seen CONTAINS '/memory/'`; accepted-`proposal` evidence sessions; hook-file edits under `~/.ax/hooks/`. Each row carries `sid` + `ts` scalars (denormalized), never `out.session`.
- The join + n-gram extraction + outcome-window matching live in a **pure** helper `tallyNgramOutcomes(turns, outcomes, { windowTurns }) => NgramOutcomeRow[]` so it is DB-free testable.

- [ ] **Step 1: Write failing test for `tallyNgramOutcomes`** - 3 synthetic same-session user turns + 1 outcome marker 5 turns after a directive turn; assert that turn's n-gram gets `outcomes: 1`, and an n-gram from an out-of-window turn gets `outcomes: 0`. Reuse the tokenizer conventions from `ingest/outcomes.ts`.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement `tallyNgramOutcomes`** (1–4-grams, stop-words + code/URL stripping per `outcomes.ts`; per-session forward outcome match ≤ `windowTurns`, default 20) and `fetchDirectiveLift` wrapping the two queries → `tallyNgramOutcomes` → `computeLift`. `baseRate` = (sessions/turns with any outcome) / (turns considered).
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(queries): fetchDirectiveLift over turns × outcomes (#587)`

## A4 - Lift-refit ingest stage

**Files:**
- Create: `apps/axctl/src/ingest/derive-directive-ngrams.ts`
- Modify: `apps/axctl/src/ingest/stage/registry.ts` (add to `ALL_STAGES`)
- Test: `apps/axctl/src/ingest/derive-directive-ngrams.test.ts`

**Interfaces - Consumes:** `fetchDirectiveLift`, `StageDef`/`StageMeta`/`IngestContext`/`BaseStageStats`. **Produces:** `directiveNgramsStage: StageDef<DirectiveNgramsStats, SurrealClient>` with `meta.key = "directive-ngrams"`, `deps: ["closure"]`, `tags: ["derive"]`. Upserts `directive_ngram` (UPSERT by `ngram`, refresh `lift`/`occurrences`/`outcomes`/`sessions`/`last_seen`/`refit_at`).

- [ ] **Step 1: Write failing test** - pure `buildNgramUpsertStatements(rows: LiftRow[]): string[]` returns one `UPSERT directive_ngram ... SET lift=...` per row, escaping the ngram into the record id (use `safeKeyPart`). Assert N rows → N statements with values present.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** the stat class (`refit: Schema.Number`), `buildNgramUpsertStatements`, and `run` (fetch lift over a fixed 90d window → upsert). Register `directiveNgramsStage` in `ALL_STAGES`.
- [ ] **Step 4: Run - expect PASS.** Also run the `ALL_STAGES`/`effect-cli.test` registry test - adding a stage historically broke it (see `content-type-classification` memory: `ALL_STAGES` change). Fix any count assertion.
- [ ] **Step 5: Commit** - `feat(ingest): directive-ngrams refit stage (#587)`

## A5 - Lift-ranked candidate flagging

**Files:**
- Modify: `apps/axctl/src/ingest/directives.ts` (add lift-aware scoring; keep v1 regex as cold-start seed)
- Modify: `apps/axctl/src/ingest/derive-proposals.ts` (`deriveProposals` reads the lift table, scores candidates)
- Test: extend `apps/axctl/src/ingest/directives.test.ts`

**Interfaces - Produces:**

```typescript
export interface ScoredDirectiveCandidate extends DirectiveCandidate {
  readonly score: number;
  readonly source: "lift" | "seed";
}
export const scoreDirectiveCandidates: (
  candidates: readonly DirectiveCandidate[],
  liftTable: ReadonlyMap<string, number>, // ngram -> lift
) => ScoredDirectiveCandidate[];
```

- [ ] **Step 1: Write failing test** - a candidate whose text contains a high-lift ngram scores above one matched only by the seed regex; cold table (empty map) falls back to `source: "seed"` + base confidence.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** `scoreDirectiveCandidates`; wire `deriveProposals` to load `directive_ngram` into a `Map<string, number>`, score candidates, and feed the ranking into `deriveDirectiveProposalRows` (highest score first, existing `limit`). Cold start (< MIN_LIFT_ROWS) → keep v1 seed behavior at lower confidence.
- [ ] **Step 4: Run - expect PASS.** `bun test apps/axctl/src/ingest/` green.
- [ ] **Step 5: Commit** - `feat(ingest): lift-rank directive candidates, seed fallback (#587)`

## A6 - `ax directives` CLI (on-demand read surface)

**Files:**
- Create: `apps/axctl/src/cli/commands/ax-directives.ts`
- Create: `apps/axctl/src/cli/directives-brief-template.ts`
- Modify: `apps/axctl/src/cli/index.ts` (register the command)
- Test: `apps/axctl/src/cli/directives-brief-template.test.ts`

**Interfaces - Consumes:** `fetchDirectiveLift`, the proposal list query (`improve/list.ts`), `renderTuneBrief` (`queries/routing-tune.ts`) + `renderClassifyBrief` (`cli/skills-classify-template.ts`) as the brief-template model, and the `ax-routing.ts` `--emit-brief` block as the write pattern. **Produces:** subcommands `mine [--emit-brief] [--days=N]`, `list [--status=...] [--json]`, `ngrams [--json] [--limit=N]`.

- [ ] **Step 1: Write failing test for `renderDirectivesBrief`** - given candidates carrying matched ngram + lift + clickable session/ts + recurrence + a per-candidate fill block (`is_directive? · canonical_text · landing(memory|guidance|hook) · rationale`), assert the markdown has the agent task instruction, one row per candidate, and the fill block.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** `renderDirectivesBrief` + the three subcommands. `mine --emit-brief` writes `.ax/tasks/directives-<date>.md` (mirror `ax-routing.ts`). `ngrams` prints the lift table (the "different users, different words" transparency surface). `list` prints tracked directive proposals sorted by recurrence (reuse `improve/list.ts` filtered to directive-origin guidance/hook proposals).
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(cli): ax directives mine|list|ngrams (#587)`

## A7 - Agent-facing read surfaces (proactive)

**Files:**
- Modify: `apps/axctl/src/dojo/schema.ts` (`DojoItemKind` += `"directives"`; add to `KIND_PRIORITY` after `brief_unfilled`)
- Modify: `apps/axctl/src/dojo/items.ts` (`directiveCandidateItems(rows): DojoItem[]`)
- Modify: `apps/axctl/src/dojo/agenda.ts` (`collectAgendaItems` collects unconfirmed directive candidates; self-clears when the brief is filled / proposal accepted)
- Modify: `apps/axctl/src/mcp/tools.ts` (add `directivesListTool`; `server.ts` auto-registers from `axMcpTools`)
- Test: `apps/axctl/src/dojo/items.test.ts`

- [ ] **Step 1: Write failing test** - `directiveCandidateItems` maps N unconfirmed candidates to a single `directives` `DojoItem` with `commands: ["ax directives mine --emit-brief"]` and a `success` criterion ("directives brief filled / proposals accepted"); empty input → no item.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** the dojo item mapper + collection wiring + the `directives_list` MCP tool (read-only, `defineMcpTool`, mirror `improveListTool`).
- [ ] **Step 4: Run - expect PASS.** `bun test apps/axctl/src/dojo/ apps/axctl/src/mcp/`.
- [ ] **Step 5: Commit** - `feat(dojo,mcp): directives agenda item + directives_list tool (#587)`

## A8 - Docs gates (distribution)

**Files:** `apps/axctl/src/cli/commands/visible-commands.ts`, `docs/cli.md`, `apps/site/public/llms.txt`, `apps/site/app/routes/docs/-cli-reference.data.ts`, root `CLAUDE.md` ("Workflow extraction commands" section).

- [ ] **Step 1:** Add `directives` (+ subcommands) to `VISIBLE_COMMANDS`.
- [ ] **Step 2:** Document `ax directives mine|list|ngrams` in `docs/cli.md` + a `CliCommand`/`CliGroup` entry in `-cli-reference.data.ts` + the `llms.txt` task group + a CLAUDE.md "### Directive mining" block.
- [ ] **Step 3:** Run the freshness lint - `bun scripts/check-site-cli-reference.ts` + `bun test` for the VISIBLE_COMMANDS gate. Expected: PASS.
- [ ] **Step 4: Commit** - `docs: ax directives reference + gates (#587)`

## A9 - MILESTONE A GATE: review-all + dogfood

- [ ] **Step 1: Full local verify** - `bun test` (repo-wide) + `bun run typecheck`. Both green.
- [ ] **Step 2: Dogfood (read+write loop on the real graph):**
  - `ax ingest --since=3` (runs the new `directive-ngrams` stage; pre-existing turns need ingest to populate lift - re-ingest a recent window).
  - `ax directives ngrams --limit=20` → confirm the user's real markers (e.g. "remember to", "from now on") outrank filler; paste the table into the PR.
  - `ax directives mine --emit-brief` → open `.ax/tasks/directives-<date>.md`; confirm top candidates are genuine standing-instructions, not tasks/questions. Note false positives.
  - `ax improve recommend` → confirm directive proposals appear; accept one via the existing brief; `ax improve lint` reconciles.
  - `ax dojo agenda --json` → confirm the `directives` item appears and self-clears after the brief is filled.
  - Record the firehose-vs-precision delta (candidates before/after lift ranking) in the PR body. **Live smoke is non-negotiable** - v1's unit tests were green but real data surfaced dispatch-prompt + mid-turn-marker FPs only visible against the real graph.
- [ ] **Step 3: `/review-all`** on the milestone diff (simplify + codex:review + adversarial-review in parallel). Triage findings; fix real ones; re-run `bun test`. Reviewers get the strong model.
- [ ] **Step 4: Open PR for #587** - body documents the dogfood evidence (ngrams table, brief sample, precision delta) and the locked Q1/Q3/Q4/Q5 decisions. Wait for CLEAN merge state.
- [ ] **Step 5:** After merge: remove worktree + local/remote branch.

---

# MILESTONE B - directive→workflow granularity ladder (#588)

**Outcome:** the same mine→ground→propose→measure loop, lifted from single-turn directives to **ordered action arcs** (e.g. `claim → worktree → TDD → verify → PR`). `ax directives workflows` mines recurring sequences and emits "codify this workflow" proposals (form=`skill`/`automation`). Builds on `workflow_epoch` + `spawned`/`invoked`. Dogfood: mining surfaces a real repeated arc from the user's own sessions.

**Write angle:** `queries/workflow-sequences.ts` (sequence detector) + a derive path emitting workflow-codification proposals.
**Read angle:** `ax directives workflows [--emit-brief|--json]` (on-demand) + reuse the dojo `experiment` agenda surface (proactive) + docs gates.

> **Gate before starting B:** Milestone A must be merged and its core bet confirmed in dogfood (users act on mined directives). If A's dogfood shows directives are ignored, STOP and report - B is speculative and gated on A proving out (spec §0.3).

## B1 - Sequence event model (pure)

**Files:**
- Create: `apps/axctl/src/queries/workflow-sequences.ts`
- Test: `apps/axctl/src/queries/workflow-sequences.test.ts`

**Interfaces - Produces:**

```typescript
export interface SeqEvent { readonly session: string; readonly tsMs: number; readonly kind: string; } // kind = skill name | tool class | episode marker
export interface ArcCandidate { readonly steps: readonly string[]; readonly support: number; readonly sessions: number; }
// Mine frequent ordered subsequences (length 3..6) appearing across >= minSessions sessions.
export const mineArcs: (
  perSession: ReadonlyMap<string, readonly SeqEvent[]>,
  opts?: { readonly minLen?: number; readonly maxLen?: number; readonly minSessions?: number },
) => ArcCandidate[];
```

- [ ] **Step 1: Write failing test** - three synthetic sessions each containing the ordered arc `["claim","worktree","tdd","verify","pr"]` plus noise; assert `mineArcs` returns that arc with `sessions: 3`, and a one-off arc is dropped by `minSessions: 2`.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement `mineArcs`** - canonicalize each session's event stream, extract ordered subsequences within length bounds, count distinct-session support, drop below `minSessions`, sort by `support`. Pure, DB-free.
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(queries): mineArcs recurring workflow sequences (#588)`

## B2 - DB-backed sequence fetch

**Files:** modify `apps/axctl/src/queries/workflow-sequences.ts`; test extends.

**Interfaces - Consumes:** `WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL` patterns from `queries/workflow.ts`, the `invoked` edge, the `spawned` edge, churn-episode markers from `metrics/session-churn.ts`. **Produces:** `fetchWorkflowArcs(input): Effect.Effect<ArcCandidate[], DbError, SurrealClient>` building `perSession` from skill invocations + tool classes + episode boundaries (deref-free: two flat selects of `{ sid, ts, kind }`, assemble per-session in JS via `buildPerSession`).

- [ ] **Step 1: Write failing test** - pure `buildPerSession(rows): Map<string, SeqEvent[]>` sorts events by `tsMs` within a session.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** `buildPerSession` + `fetchWorkflowArcs` → `mineArcs`.
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(queries): fetchWorkflowArcs over invoked/spawned/episodes (#588)`

## B3 - Workflow-codification proposal path

**Files:** modify `apps/axctl/src/ingest/derive-proposals.ts` (add `deriveWorkflowProposalRows`); reuse the `buildGuidanceProposalStatements` shape but form=`skill`/`automation`. Test extends `derive-proposals.test.ts`.

**Interfaces - Produces:** `deriveWorkflowProposalRows(arcs: ArcCandidate[], opts): { rows; skipped }` - title = arc summary ("Codify: claim→worktree→tdd→verify→pr"), landing = `skill`, `frequency` = support, stable `dedupe_sig`.

- [ ] **Step 1: Write failing test** - N arcs → N proposal rows with `skill`/`automation` form, support→frequency, stable sigs; sub-`minSessions` arcs skipped.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** + wire into `deriveProposals` (only emits when arcs exist). Add `workflowProposals` to `ProposalsStats`.
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(ingest): workflow-codification proposals (#588)`

## B4 - `ax directives workflows` + docs

**Files:** modify `apps/axctl/src/cli/commands/ax-directives.ts` (add `workflows` subcommand → `--emit-brief` writes `.ax/tasks/workflows-<date>.md`, `--json`), the four docs gates, root CLAUDE.md.

- [ ] **Step 1:** Add `workflows` subcommand + `renderWorkflowsBrief` (test it like A6: one row per arc + a "codify as skill/checklist/command?" fill block). Failing test → implement → pass.
- [ ] **Step 2:** Update `VISIBLE_COMMANDS`, `cli.md`, `-cli-reference.data.ts`, `llms.txt`, CLAUDE.md. Run freshness lint.
- [ ] **Step 3: Commit** - `feat(cli): ax directives workflows + docs (#588)`

## B5 - MILESTONE B GATE: review-all + dogfood

- [ ] **Step 1:** `bun test` + `bun run typecheck` green.
- [ ] **Step 2: Dogfood** - `ax directives workflows --emit-brief` on the real graph; confirm it surfaces a *genuine* repeated arc (cross-check against `ax-extract-workflow` on a known shipped artifact). Note precision; if arcs are noise, raise `minSessions` / lower confidence and document.
- [ ] **Step 3: `/review-all`**; triage + fix.
- [ ] **Step 4: PR #588** with dogfood evidence (the mined arc + its source sessions). CLEAN-merge gate.
- [ ] **Step 5:** Worktree/branch cleanup post-merge.

---

# MILESTONE C - community pattern layer (#589) - BLOCKED on security redesign

**Outcome:** day-1 value via a curated+contributed pattern library with a **code-only** detector registry (data never carries SurrealQL), behind a redesign that closes the five §0.4 security blockers. `ax patterns list/adopt/suggest` (safe, consume-only) ship first; contribution + compile ship only after the redesign is reviewed.

**Write angle:** detector registry (`patterns/detectors/*.ts`), per-user `community/patterns/contributed/<login>.json` (consent-gated), nightly compile → `index.json`/`trending.json`.
**Read angle:** `ax patterns list/adopt/suggest` (on-demand) + site `/patterns` + `/leaders` trending board (public read) + MCP `patterns_suggest` (agent-facing) + docs gates.

## C0 - Security redesign (DESIGN ONLY - no production code)

**Files:** Create `docs/superpowers/specs/2026-06-22-community-patterns-security-redesign.md`.

> This is a design gate. Produce the redesign, get it reviewed, and only then unblock C3/C4. C1 + C2 are independently safe and may proceed in parallel.

- [ ] **Step 1:** Write the redesign resolving each §0.4 blocker with a concrete mechanism:
  1. **No code-exec sinks:** detector `params` are a **closed typed schema** (enum + bound values), bound never interpolated into SurrealQL; site renders pattern text escaped (no `dangerouslySetInnerHTML`); contributed JSON is data-only (the `community-users.yml` PR-head-never-executed model).
  2. **Sybil:** content-hash dedup is a sybil *signal*, not the counter; require contributor account history (age/activity); invert "many fresh accounts, identical hash = sybil"; **human gate before graduation** to the public board.
  3. **Abstraction leak:** publish from **user gists** (profile-publish model), NOT repo forks of `contributed/<login>.json`; drop `phrasings` (raw turns) from published artifacts entirely; ship only the abstracted pattern shape.
  4. **Consent drift:** per-change consent - show the *diff* and require an explicit yes before any PATCH (no one-time blanket consent).
  5. **Case evidence scrubbing:** define a deterministic scrubber (strip paths/repo/names) with tests; cases ship `detector_id` + evidence *shape*, never raw `command_text`.
- [ ] **Step 2:** `/review-all` (or a dedicated adversarial review) on the redesign doc with a privacy/security lens. Iterate until the reviewer signs off on all 5 blockers.
- [ ] **Step 3: Commit** - `docs(spec): community patterns security redesign (#589)`. **Unblock gate:** C3/C4 may start only after this is reviewed-approved.

## C1 - `ax patterns list/adopt/suggest` over the seed (SAFE, consume-only)

**Files:**
- Create: `apps/axctl/src/cli/commands/ax-patterns.ts`
- Create: `apps/axctl/src/patterns/seed-loader.ts` (read+validate `community/patterns/seed.json`)
- Test: `apps/axctl/src/patterns/seed-loader.test.ts`

**Interfaces - Consumes:** the shipped `seed.json` schema (`{ version, categories, landings, patterns[] }`), the `improve accept` brief path (`improve/actions.ts:acceptProposal`). **Produces:** `list [--category=C] [--json]`, `adopt <id>` (writes the pattern via the brief path per its `landing`), `suggest` (gap vs installed hooks + `feedback-*` memories - keyword-level in C1, grounded in C2).

- [ ] **Step 1: Write failing test** - `loadSeedPatterns()` validates and returns typed `Pattern[]`; rejects a malformed entry (missing `landing`).
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** the loader + the three subcommands. `adopt` routes through the `acceptProposal`-style brief emission so it inherits accept/lint. `suggest` (C1 form) lists patterns not present in installed hooks / memories.
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5:** Docs gates for `ax patterns` (VISIBLE_COMMANDS, cli.md, -cli-reference.data.ts, llms.txt, CLAUDE.md). Freshness lint green.
- [ ] **Step 6: Commit** - `feat(cli): ax patterns list|adopt|suggest over seed (#589)`

## C2 - Detector registry (code - makes `suggest` grounded)

**Files:**
- Create: `apps/axctl/src/patterns/detectors/index.ts` (registry) + one file per detector
- Test: `apps/axctl/src/patterns/detectors/*.test.ts`

**Interfaces - Consumes:** `check-family.ts`, churn-episode logic (`metrics/session-churn.ts`), the `edited`/branch signal, `feedback-cases.ts` (the "candidate query + verdict" primitive). **Produces:**

```typescript
export interface Detector {
  readonly id: string;                 // e.g. "done-without-verification"
  readonly paramsSchema: ZodRawShape;  // closed typed params (security boundary)
  readonly run: (params, input) => Effect.Effect<readonly EvidenceRow[], DbError, SurrealClient>;
}
export const DETECTOR_REGISTRY: ReadonlyMap<string, Detector>;
```

Seed detectors (per §7.5): `done-without-verification`, `edit-on-main`, `delete-without-dryrun`, `git-add-all`, `edit-without-prior-read`.

- [ ] **Step 1: Write failing tests** - for each detector, a synthetic-fixture test asserting it returns violation rows on a violating session and none on a clean one (model on `feedback-cases.test.ts`).
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** each detector as a named deref-free query reusing existing toolkits; assemble `DETECTOR_REGISTRY`. Wire `ax patterns suggest` to run groundable detectors over the graph → patterns the user *actually violates*, ranked by violation count.
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5:** Add `patterns_suggest` MCP tool (read-only, agent-facing).
- [ ] **Step 6: Commit** - `feat(patterns): detector registry + grounded suggest (#589)`

## C3 - Consent-gated contribution (gated on C0 approval)

**Files:**
- Create: `apps/axctl/src/patterns/contribute.ts` (consent + gist publish)
- Create: `apps/axctl/src/patterns/abstract.ts` (raw directive → pattern shape; deterministic scrubber)
- Test: `apps/axctl/src/patterns/abstract.test.ts`, `contribute.test.ts`

**Interfaces - Consumes:** `profile/publish.ts` (gist create/PATCH + consent), `profile/publish-state.ts` (state file model). **Produces:** `ax patterns contribute` - abstracts local accepted directives to pattern shapes, runs the deterministic scrubber (C0 step 5), shows the exact JSON diff, one explicit yes, publishes to the user's gist (NOT a repo fork). Drops `phrasings`.

- [ ] **Step 1: Write failing test** - `abstractDirective(raw)` strips paths/repo/names (a directive mentioning `/Users/x/Projects/foo` and `feat/123` abstracts to a clean shape with no specifics); `scrub()` is idempotent.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** abstraction + scrubber + consent-gated publish (mirror `ax profile publish`: show JSON, `--yes` to skip prompt, per-change diff consent). State at `~/.ax/patterns-contribute.json`. Add `scripts/validate-community-patterns.ts` mirroring `validate-community-users.ts` (schema + author==filename, data-only).
- [ ] **Step 4: Run - expect PASS.**
- [ ] **Step 5: Commit** - `feat(patterns): consent-gated contribution + scrubber (#589)`

## C4 - Nightly compile + trending board

**Files:**
- Modify: `scripts/compile-community.ts` / `packages/community-compile` - merge curated + contributed gists → `community/patterns/index.json` + `community/patterns/trending.json` (dedup by content hash, graduate at ≥N independent contributors with the C0 human gate).
- Modify: `.github/workflows/community-nightly.yml`
- Create: `apps/site/app/routes/patterns.tsx` (browse) + extend `/leaders` with a trending-patterns board beside trending-skills; validators in `apps/site/app/lib/community.ts`.
- Test: compile-side unit tests (dedup, threshold, absurd-row drop).

- [ ] **Step 1: Write failing test** - the compile fn merges seed + two contributed gists, dedups identical-hash patterns, graduates only at ≥N independent contributors, drops malformed rows.
- [ ] **Step 2: Run - expect FAIL.**
- [ ] **Step 3: Implement** the compile extension + the site routes (manual validation, no Effect on the site). Mirror `trendingSkills()` for `trendingPatterns()`.
- [ ] **Step 4: Run - expect PASS.** Site `bun run typecheck` (needs prior build for route codegen).
- [ ] **Step 5: Commit** - `feat(community): patterns compile + trending board (#589)`

## C5 - MILESTONE C GATE: review-all + dogfood

- [ ] **Step 1:** `bun test` + `bun run typecheck` (CLI + site) green.
- [ ] **Step 2: Dogfood** - `ax patterns list`, `ax patterns suggest` (confirm grounded detectors flag a real violation in the user's graph), `ax patterns adopt <id>` (confirm the brief lands). For contribution: dry-run `ax patterns contribute` and confirm the JSON shows ZERO specifics (paths/repos/names) - the privacy guarantee. Verify the consent prompt shows the diff.
- [ ] **Step 3: `/review-all`** with a **security/privacy lens** (re-run the C0 adversarial reviewer against the actual code, not just the spec). Confirm: no SurrealQL in data, no raw turns published, per-change consent enforced, human graduation gate present. Fix any finding.
- [ ] **Step 4: PRs** - C1+C2 as one PR (safe slice); C3+C4 as a second PR (post-redesign). Each CLEAN-merge gated. Document the privacy dogfood evidence in the C3/C4 PR body.
- [ ] **Step 5:** Worktree/branch cleanup post-merge. Close #589 only after C3/C4 land (C1/C2 alone don't close it).

---

## Self-Review (against the spec + the 3 issues)

**Spec coverage:**
- §2.1 n-gram-lift miner → Milestone A (A2 lift, A3 fetch, A4 refit stage, A5 ranking). ✓
- §2.5 recurrence→escalate → A5 (`frequency`) + A7 (dojo) + Q3 escalation rule. ✓
- §2.7 workflow ladder → Milestone B. ✓
- §7.1 seed consume → C1; §7.5 detector registry → C2; §7.3 contribution → C3; §7.6 conflict-free per-user files → C3/C4; §7 trending board → C4. ✓
- §0.4 five security blockers → C0 (each mapped to a mechanism) + C5 security-lens review. ✓
- Q1/Q3/Q4/Q5 open questions → locked in "Locked design decisions". ✓

**Read & write coverage (ship-checklist) per milestone:** every new write (table/stage/query) has an on-demand CLI read, a proactive agent-facing read (dojo item / MCP tool), and docs/distribution gates. A: A1/A4/A5 write ↔ A6 CLI + A7 dojo/MCP + A8 docs. B: B1–B3 write ↔ B4 CLI + docs. C: C2/C3/C4 write ↔ C1/C2 CLI + C2/C5 MCP + C4 site + docs. ✓

**Review gates:** A9, B5, C5 each run `/review-all` (simplify + codex:review + adversarial-review in parallel) after the milestone; C5 adds a security/privacy lens. Reviewers get the strong model (`feedback-review-gets-strong-model`). ✓

**Placeholder scan:** novel pure logic (lift, arc-mining, abstraction/scrub) carries real test code + impl; wiring tasks carry exact signatures + the existing file:line model to copy. No "TBD"/"handle edge cases".

## Open decisions for the operator (answer before/while executing)

1. **Milestone gating is hard:** B and C3/C4 are explicitly gated on A's bet proving out (and C0's redesign). If A's dogfood shows directives are ignored, do you still want B/C built, or pause and reassess?
2. **Contribution threshold N** (C4 graduation) - what value? (Higher = safer/less identifying, slower to grow.) Spec §8 Q7.
3. **Seed-on-install** - does `ax install` auto-offer the seed pack (opt-in prompt), or stay pure-pull (`ax patterns adopt`)? Spec §8 Q8.
4. **Issue→PR mapping** - A=one PR; B=one PR; C=two PRs (C1+C2 safe slice, C3+C4 post-redesign). Confirm, or split finer.

---

## Execution Handoff

Hand this to **subagent-driven development** (REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`): a fresh subagent per task, two-stage review between tasks, and the mandatory `/review-all` + dogfood gate at each milestone boundary (A9, B5, C5). Each milestone is its own issue (#587, #588, #589) and its own worktree/branch/PR.
