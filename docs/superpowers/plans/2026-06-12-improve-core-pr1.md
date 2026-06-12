# Improve Core (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/api/next-actions` - ranked "what should I work on next" cards with server-generated copy-pasteable agent briefs - and rebuild the Improve route into three zones (Next Actions / Proposals / Decisions), plus filter synthetic `codex:*` skills out of skill surfaces.

**Architecture:** New pure card-builder + brief-renderer modules in `apps/axctl/src/dashboard/`, aggregated by an Effect handler that fans out to six existing data sources with per-source fail-open. Wire types live in `packages/lib/src/shared/dashboard-types.ts`. Frontend adds a `NextActionsPanel` + `CopyButton` and folds the Decisions route content into `improve.tsx` as a section component.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect 4 beta (`Effect.fn`, `Effect.gen`), SurrealDB 3 via `SurrealClient` from `@ax/lib/db`, React 18 + TanStack Query (studio), bun:test.

**Spec:** `docs/superpowers/specs/2026-06-12-improve-first-dashboard-design.md` (PR1 scope).

**Conventions for the implementer:**
- Before writing any Effect code, run `effect-solutions show basics error-handling services-and-layers` (repo rule).
- Tests: plain `bun test <file>`. If a global hook blocks `bun test`, create a tmp wrapper script that invokes it and run that (known environment quirk).
- SurrealDB perf rule (learned the hard way): never stack record derefs (`out.name`, `in.session`) inside aggregates over the 87k-row `invoked` table. Aggregate deref-free, join names in JS.
- Never `git add -A`. Stage explicit paths.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/lib/src/shared/dashboard-types.ts` (modify) | Wire types: `NextActionCard`, `NextActionsPayload`, `ProposalDto.brief` |
| `apps/axctl/src/dashboard/agent-brief.ts` (create) | Pure markdown brief renderer |
| `apps/axctl/src/dashboard/agent-brief.test.ts` (create) | |
| `apps/axctl/src/queries/skill-hygiene.ts` (create) | Deref-free "unclassified skills ≥3 invocations" query |
| `apps/axctl/src/queries/skill-hygiene.test.ts` (create) | |
| `apps/axctl/src/dashboard/improve-proposals.ts` (create) | `/api/improve` SQL extracted into a reusable fetch fn |
| `apps/axctl/src/dashboard/next-actions.ts` (create) | Pure card builders per source + `fetchNextActions` aggregator |
| `apps/axctl/src/dashboard/next-actions.test.ts` (create) | |
| `apps/axctl/src/dashboard/router/routes/improve.ts` (modify) | Register `GET /api/next-actions` |
| `apps/axctl/src/dashboard/router/routes/system.ts` (modify) | `/api/improve` delegates to `improve-proposals.ts`, adds `brief` per proposal |
| `apps/axctl/src/queries/project.ts` (modify) | Synthetic-skill filter in `PROJECT_TOP_SKILLS_SQL` |
| `apps/axctl/src/cli/skills-classify.ts` (modify) | Synthetic-skill filter in `buildDefaultSql()` |
| `apps/studio/src/api.ts` (modify) | `api.nextActions()` |
| `apps/studio/src/components/copy-button.tsx` (create) | Clipboard button (net-new - no existing helper) |
| `apps/studio/src/components/decisions-section.tsx` (create) | Decision log table extracted from `routes/decisions.tsx` |
| `apps/studio/src/components/next-actions-panel.tsx` (create) | Card grid for `/api/next-actions` |
| `apps/studio/src/routes/decisions.tsx` (modify) | Thin wrapper around `DecisionsSection` (route removal is PR2) |
| `apps/studio/src/routes/improve.tsx` (modify) | Three zones |

---

### Task 1: Wire types

**Files:**
- Modify: `packages/lib/src/shared/dashboard-types.ts` (append after `ImprovePayload`, ~line 1195)

- [ ] **Step 1: Add types**

```ts
// ---- Next actions (improve-first dashboard, PR1) ----

export type NextActionKind =
    | "proposal"
    | "verdict"
    | "tool_failure"
    | "churn"
    | "routing"
    | "skill_hygiene";

export interface NextActionInlineAction {
    readonly type: "accept" | "reject" | "verdict" | "decide";
    /** proposal dedupe_sig for accept/reject/verdict */
    readonly sig: string | null;
    /** skill name for decide */
    readonly skill: string | null;
    /** suggested verdict for one-click lock */
    readonly suggested_verdict: string | null;
}

export interface NextActionCard {
    /** stable id: `${kind}:${key}` */
    readonly id: string;
    readonly kind: NextActionKind;
    readonly title: string;
    /** one-line evidence summary */
    readonly evidence: string;
    /** rank score, higher first; KIND_WEIGHT + per-source bonus */
    readonly impact: number;
    /** server-rendered markdown agent brief */
    readonly brief: string;
    /** SPA drill-down path, e.g. /tools */
    readonly link: string | null;
    readonly inline_action: NextActionInlineAction | null;
}

export interface NextActionsSourceNote {
    readonly source: NextActionKind;
    readonly note: string;
}

export interface NextActionsPayload {
    readonly generatedAt: string;
    readonly cards: ReadonlyArray<NextActionCard>;
    /** sources that failed or were skipped - fail-open, never 500 the panel */
    readonly notes: ReadonlyArray<NextActionsSourceNote>;
}
```

- [ ] **Step 2: Add `brief` to `ProposalDto`** - inside the existing `ProposalDto` interface (~line 1174), after `created_at`:

```ts
    /** server-rendered markdown agent brief (PR1) */
    readonly brief?: string;
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (types only, no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add packages/lib/src/shared/dashboard-types.ts
git commit -m "feat(dashboard-types): next-actions wire types + ProposalDto.brief"
```

---

### Task 2: Agent brief renderer

**Files:**
- Create: `apps/axctl/src/dashboard/agent-brief.ts`
- Test: `apps/axctl/src/dashboard/agent-brief.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { renderAgentBrief } from "./agent-brief.ts";

describe("renderAgentBrief", () => {
    test("renders the agreed markdown shape", () => {
        const md = renderAgentBrief({
            title: "Fix `bun test` exit-127 cluster in ax",
            evidence: "14 failures / 6 sessions, exit 127 (sessions: 01jx, 01jy)",
            ask: "Add a PATH-safe test wrapper so `bun test` resolves in worktrees.",
            verify: "`ax sessions churn --here` failure count drops over the next 7d window.",
            source: "ax tool-failure label=Bash",
        });
        expect(md).toBe(
            [
                "## Task: Fix `bun test` exit-127 cluster in ax",
                "",
                "**Evidence:** 14 failures / 6 sessions, exit 127 (sessions: 01jx, 01jy)",
                "",
                "**Ask:** Add a PATH-safe test wrapper so `bun test` resolves in worktrees.",
                "",
                "**Verify:** `ax sessions churn --here` failure count drops over the next 7d window.",
                "",
                "_source: ax tool-failure label=Bash_",
            ].join("\n"),
        );
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/agent-brief.test.ts`
Expected: FAIL - cannot resolve `./agent-brief.ts`

- [ ] **Step 3: Implement**

```ts
/** Pure renderer for copy-pasteable agent task briefs (spec: improve-first dashboard). */

export interface AgentBrief {
    readonly title: string;
    readonly evidence: string;
    readonly ask: string;
    readonly verify: string;
    readonly source: string;
}

export const renderAgentBrief = (b: AgentBrief): string =>
    [
        `## Task: ${b.title}`,
        "",
        `**Evidence:** ${b.evidence}`,
        "",
        `**Ask:** ${b.ask}`,
        "",
        `**Verify:** ${b.verify}`,
        "",
        `_source: ${b.source}_`,
    ].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/dashboard/agent-brief.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dashboard/agent-brief.ts apps/axctl/src/dashboard/agent-brief.test.ts
git commit -m "feat(dashboard): agent brief renderer"
```

---

### Task 3: Skill-hygiene query (deref-free)

**Files:**
- Create: `apps/axctl/src/queries/skill-hygiene.ts`
- Test: `apps/axctl/src/queries/skill-hygiene.test.ts`

Unclassified skills with ≥3 invocations. The CLI version (`apps/axctl/src/cli/skills-classify.ts:34-46`) uses correlated `$parent.id` subqueries - O(skills × edges), known hang risk. This module aggregates deref-free and joins in JS, mirroring `apps/axctl/src/dashboard/skills-weighted.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchSkillHygiene } from "./skill-hygiene.ts";

type QueryResult = Array<Record<string, unknown>>;

const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => Effect.succeed(results as [QueryResult, ...QueryResult[]]),
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
) => Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("fetchSkillHygiene", () => {
    test("joins counts to names, drops synthetic + classified + low-count", async () => {
        const rows = await run(
            fetchSkillHygiene({ minInvocations: 3, limit: 10 }),
            makeMockDb([
                // statement 1: invocation counts by skill id
                [
                    { sid: "skill:composto", invocations: 41 },
                    { sid: "skill:codex_exec", invocations: 39545 },
                    { sid: "skill:tagged", invocations: 12 },
                    { sid: "skill:rare", invocations: 2 },
                ],
                // statement 2: skill rows
                [
                    { id: "skill:composto", name: "composto", dir_path: "/skills/composto" },
                    { id: "skill:codex_exec", name: "codex:exec_command", dir_path: "(synthetic)" },
                    { id: "skill:tagged", name: "tagged", dir_path: "/skills/tagged" },
                    { id: "skill:rare", name: "rare", dir_path: "/skills/rare" },
                ],
                // statement 3: classified skill ids
                ["skill:tagged"],
            ]),
        );
        expect(rows).toEqual([{ name: "composto", invocations: 41 }]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/queries/skill-hygiene.test.ts`
Expected: FAIL - cannot resolve `./skill-hygiene.ts`

- [ ] **Step 3: Implement**

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

export interface SkillHygieneRow {
    readonly name: string;
    readonly invocations: number;
}

export interface SkillHygieneInput {
    readonly minInvocations: number;
    readonly limit: number;
}

// Deref-free aggregate over `invoked`; names joined in JS (see weighted-query hang lesson).
const SQL = `
SELECT out AS sid, count() AS invocations FROM invoked GROUP BY sid;
SELECT id, name, dir_path FROM skill;
SELECT VALUE in FROM plays_role WHERE source IN ["frontmatter", "brief", "user"];
`;

const rid = (v: unknown): string => String(v);

export const fetchSkillHygiene = Effect.fn("queries.fetchSkillHygiene")(function* (
    input: SkillHygieneInput,
) {
    const db = yield* SurrealClient;
    const [counts, skills, classified] = yield* db.query<
        [
            Array<{ sid: unknown; invocations: number }>,
            Array<{ id: unknown; name: string; dir_path: string | null }>,
            Array<unknown>,
        ]
    >(SQL);

    const classifiedIds = new Set((classified ?? []).map(rid));
    const byId = new Map(
        (skills ?? []).map((s) => [rid(s.id), { name: s.name, dir_path: s.dir_path }]),
    );

    const rows: SkillHygieneRow[] = [];
    for (const c of counts ?? []) {
        const sid = rid(c.sid);
        const skill = byId.get(sid);
        if (!skill) continue;
        if (skill.dir_path === "(synthetic)") continue;
        if (classifiedIds.has(sid)) continue;
        if (c.invocations < input.minInvocations) continue;
        rows.push({ name: skill.name, invocations: c.invocations });
    }
    rows.sort((a, b) => b.invocations - a.invocations);
    return rows.slice(0, input.limit);
});
```

Check the exact `SurrealClientShape.query` signature in `packages/lib/src/db.ts` before writing - match how `apps/axctl/src/queries/dispatch-analytics.ts` calls it (it is the closest sibling).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/queries/skill-hygiene.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/skill-hygiene.ts apps/axctl/src/queries/skill-hygiene.test.ts
git commit -m "feat(queries): deref-free skill hygiene candidates"
```

---

### Task 4: Extract improve-proposals fetch fn

**Files:**
- Create: `apps/axctl/src/dashboard/improve-proposals.ts`
- Modify: `apps/axctl/src/dashboard/router/routes/system.ts:102-130`

The `/api/improve` handler embeds its SQL inline. Next-actions needs the same data - extract, don't duplicate.

- [ ] **Step 1: Create the module by moving code**

Cut the SQL string and the `Effect.gen` body from the `/api/improve` route in `system.ts` (lines ~102-130) into:

```ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { ProposalDto } from "@ax/lib/shared/dashboard-types";

const PROPOSALS_SQL = `/* moved verbatim from system.ts /api/improve handler */`;

/** Raw proposal rows, loosely typed at the edge like the legacy queryApi endpoints. */
export const fetchImproveProposals = Effect.fn("dashboard.fetchImproveProposals")(
    function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(PROPOSALS_SQL);
        return (result?.[0] ?? []) as unknown as ReadonlyArray<ProposalDto>;
    },
);
```

- [ ] **Step 2: Rewire the route**

In `system.ts`, the `/api/improve` handler becomes:

```ts
handler: () =>
    fetchImproveProposals().pipe(
        Effect.map((proposals) => ({ proposals })),
    ),
```

(import `fetchImproveProposals` from `"../../improve-proposals.ts"` - adjust relative path to match siblings' import style in that file).

- [ ] **Step 3: Verify no behavior change**

Run: `bun test apps/axctl/src/dashboard && bun run typecheck`
Expected: PASS (existing route tests, if any, still green; typecheck clean)

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/dashboard/improve-proposals.ts apps/axctl/src/dashboard/router/routes/system.ts
git commit -m "refactor(dashboard): extract fetchImproveProposals from /api/improve"
```

---

### Task 5: Card builders (pure)

**Files:**
- Create: `apps/axctl/src/dashboard/next-actions.ts`
- Test: `apps/axctl/src/dashboard/next-actions.test.ts`

Six pure builders: rows in → `NextActionCard[]` out, each with impact score + rendered brief. Aggregator comes in Task 6 (same file).

Ranking: `impact = KIND_WEIGHT[kind] + bonus(0..9)`. Kind weights express triage order: verdicts (decisions overdue) > proposals > tool failures > routing savings > churn > hygiene.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import type {
    ProposalDto,
    ToolFailureEntry,
} from "@ax/lib/shared/dashboard-types";
import {
    churnCards,
    proposalCards,
    routingCards,
    skillHygieneCards,
    toolFailureCards,
    verdictCards,
} from "./next-actions.ts";

const baseProposal = (over: Partial<ProposalDto>): ProposalDto =>
    ({
        id: "proposal:1",
        form: "skill",
        title: "Add retry guard skill",
        hypothesis: "h",
        dedupe_sig: "sig-1",
        frequency: 7,
        confidence: "high",
        status: "open",
        reject_reason: null,
        created_at: "2026-06-01T00:00:00Z",
        experiment: null,
    }) as ProposalDto;

describe("proposalCards", () => {
    test("open proposals only, ranked by confidence x frequency, with brief + inline accept", () => {
        const cards = proposalCards([
            baseProposal({}),
            baseProposal({ dedupe_sig: "sig-2", status: "accepted" }),
        ]);
        expect(cards).toHaveLength(1);
        const card = cards[0]!;
        expect(card.kind).toBe("proposal");
        expect(card.id).toBe("proposal:sig-1");
        expect(card.inline_action).toEqual({
            type: "accept",
            sig: "sig-1",
            skill: null,
            suggested_verdict: null,
        });
        expect(card.brief).toContain("## Task:");
        expect(card.brief).toContain("sig=sig-1");
        expect(card.impact).toBeGreaterThan(80);
    });
});

describe("verdictCards", () => {
    test("accepted experiment without locked verdict yields a verdict card", () => {
        const cards = verdictCards([
            baseProposal({
                status: "accepted",
                experiment: {
                    id: "experiment:1",
                    artifact_path: null,
                    status: "scaffolded",
                    task_path: null,
                    locked_verdict: null,
                    created_at: "2026-06-01T00:00:00Z",
                    scaffolded_at: null,
                    latest_checkpoint: {
                        kind: "+10s",
                        suggested: "adopted",
                        user_verdict: null,
                        measured: null,
                        observed_at: "2026-06-10T00:00:00Z",
                    },
                },
            }),
        ]);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.kind).toBe("verdict");
        expect(cards[0]!.inline_action?.type).toBe("verdict");
        expect(cards[0]!.inline_action?.suggested_verdict).toBe("adopted");
        expect(cards[0]!.impact).toBeGreaterThan(90);
    });
});

describe("toolFailureCards", () => {
    test("only recommendation=fix becomes a card, linked to /tools", () => {
        const entry: ToolFailureEntry = {
            label: "Bash",
            failure_count: 14,
            last_seen: "2026-06-10T00:00:00Z",
            last_error_text: "exit 127",
            last_project: "ax",
            distinct_sessions: 6,
            total_calls: 200,
            failure_rate: 0.07,
            exit_codes: [127],
            recommendation: "fix",
            recommendation_reason: "recent, recurring",
        };
        const cards = toolFailureCards([entry, { ...entry, label: "Read", recommendation: "watch" }]);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.link).toBe("/tools");
        expect(cards[0]!.evidence).toContain("14 failures / 6 sessions");
    });
});

describe("routingCards", () => {
    test("candidates with savings become cards with $ evidence", () => {
        const cards = routingCards({
            candidates: [
                {
                    ts: "2026-06-10T00:00:00Z",
                    parent_id: "p",
                    child_id: "c",
                    agent_type: "general-purpose",
                    description: "implement task 3",
                    dispatch_model: "inherit",
                    child_model: "claude-fable-5",
                    child_cost_usd: 1.2,
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    cache_read_tokens: 0,
                    cache_create_tokens: 0,
                    routing_match: { classId: "task-N-impl" },
                    suggested_model: "claude-sonnet-4-6",
                    est_savings_usd: 0.9,
                } as never,
            ],
            total_est_savings_usd: 0.9,
            top_classes: [{ classId: "task-N-impl", savings_usd: 0.9 }],
        } as never);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.kind).toBe("routing");
        expect(cards[0]!.evidence).toContain("$0.90");
    });
});

describe("churnCards", () => {
    test("repair-heavy sessions become outlier cards", () => {
        const cards = churnCards({
            generatedAt: "2026-06-12T00:00:00Z",
            filters: { since: null, project: null, source: null, limit: 20 },
            aggregates: [],
            hotSessions: [
                {
                    sessionId: "01jx",
                    source: "claude",
                    taskLabel: "fix ingest",
                    landedLinesAdded: 50,
                    landedLinesRemoved: 10,
                    editLinesAdded: 0,
                    editLinesRemoved: 0,
                    repairLinesAdded: 300,
                    repairLinesRemoved: 120,
                    editEvents: 40,
                    verificationFailures: 6,
                    verificationPasses: 2,
                    episodes: 3,
                    passedEpisodes: 1,
                    topCheck: "bun test",
                } as never,
            ],
        } as never);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.kind).toBe("churn");
        expect(cards[0]!.evidence).toContain("01jx");
    });
});

describe("skillHygieneCards", () => {
    test("unclassified skills become decide cards", () => {
        const cards = skillHygieneCards([{ name: "composto", invocations: 41 }]);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.inline_action).toEqual({
            type: "decide",
            sig: null,
            skill: "composto",
            suggested_verdict: null,
        });
    });
});
```

Field-name caution: before finalizing the churn test fixture, open `apps/axctl/src/metrics/session-churn.ts:32-48` and copy the exact `SessionChurnRow` property names - the fixture above is from a second-hand report. Same for `CandidateRow` in `apps/axctl/src/queries/dispatch-analytics.ts:223-265`. Use `satisfies`/real types instead of `as never` wherever the real shapes allow.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/axctl/src/dashboard/next-actions.test.ts`
Expected: FAIL - cannot resolve `./next-actions.ts`

- [ ] **Step 3: Implement builders**

```ts
import type {
    NextActionCard,
    NextActionKind,
    ProposalDto,
    ToolFailureEntry,
} from "@ax/lib/shared/dashboard-types";
import type { SessionChurnSummary } from "../metrics/session-churn.ts";
import type { CandidatesResult } from "../queries/dispatch-analytics.ts";
import type { SkillHygieneRow } from "../queries/skill-hygiene.ts";
import { renderAgentBrief } from "./agent-brief.ts";

const KIND_WEIGHT: Record<NextActionKind, number> = {
    verdict: 90,
    proposal: 80,
    tool_failure: 70,
    routing: 60,
    churn: 50,
    skill_hygiene: 40,
};

const CONFIDENCE_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

const bonus = (n: number): number => Math.max(0, Math.min(9, Math.round(n)));

const PER_SOURCE_CAP = 5;

export const proposalCards = (
    proposals: ReadonlyArray<ProposalDto>,
): NextActionCard[] =>
    proposals
        .filter((p) => p.status === "open")
        .map((p): NextActionCard => {
            const cw = CONFIDENCE_WEIGHT[p.confidence] ?? 1;
            return {
                id: `proposal:${p.dedupe_sig}`,
                kind: "proposal",
                title: `Decide proposal: ${p.title}`,
                evidence: `${p.form} proposal, confidence ${p.confidence}, seen ${p.frequency}x`,
                impact: KIND_WEIGHT.proposal + bonus(cw * Math.log2(p.frequency + 1)),
                brief: renderAgentBrief({
                    title: p.title,
                    evidence: `hypothesis: ${p.hypothesis} (seen ${p.frequency}x, confidence ${p.confidence})`,
                    ask: "Review this proposal; if sound, run `ax improve accept` and act on the emitted .ax/tasks brief.",
                    verify: "`ax improve show` reflects accepted status; follow the experiment checkpoints.",
                    source: `ax improve proposal sig=${p.dedupe_sig}`,
                }),
                link: null,
                inline_action: { type: "accept", sig: p.dedupe_sig, skill: null, suggested_verdict: null },
            };
        })
        .sort((a, b) => b.impact - a.impact)
        .slice(0, PER_SOURCE_CAP);
```

`verdictCards`: filter `p.status === "accepted" && p.experiment && !p.experiment.locked_verdict`; suggested = `p.experiment.latest_checkpoint?.suggested ?? null`; title `Lock verdict: ${p.title}`; evidence names the suggestion or "no checkpoint yet"; bonus `+3` when a suggestion exists; brief Ask = "Lock the verdict (suggested: X) via the Improve dashboard or `ax improve` CLI; if evidence is thin, check retro notes first." inline_action `{ type: "verdict", sig, skill: null, suggested_verdict: suggested }`.

`toolFailureCards`: filter `recommendation === "fix"`; title `Fix \`${f.label}\` failure cluster`; evidence `` `${f.failure_count} failures / ${f.distinct_sessions} sessions, exits [${f.exit_codes.join(", ")}]` ``; bonus `log2(failure_count)`; link `/tools`; brief Ask = "Diagnose the dominant failure mode and fix root cause (env, flag, or guard)."; Verify = "failure_count for this label stops growing in /api/tool-failures over the next 7d"; source `ax tool-failure label=${f.label}`; no inline_action.

`churnCards`: for each `hotSessions` row compute `repair = repairLinesAdded + repairLinesRemoved`, `landed = landedLinesAdded + landedLinesRemoved`; outlier when `repair >= 100 && repair >= 0.5 * Math.max(landed, 1)` OR `verificationFailures >= 5`; title `Investigate churny session ${sessionId}`; evidence `` `${sessionId} (${taskLabel ?? source}): ${repair} repair LOC vs ${landed} landed, ${verificationFailures} failed checks` ``; bonus `verificationFailures`; link `/sessions/${sessionId}`; brief Ask = "Reconstruct what kept failing (ax sessions show <id>) and turn the recurring failure into a proposal (guidance/hook/skill)."; source `ax sessions churn session=${sessionId}`; no inline_action.

`routingCards`: filter `est_savings_usd >= 0.01`; title `Route ${routing_match.classId} dispatches to ${suggested_model}`; evidence `` `$${est_savings_usd.toFixed(2)} est savings - "${description}" went to ${child_model}` ``; bonus `est_savings_usd` (clamped); brief Ask = "Add an explicit model to this dispatch pattern (or extend the routing class) so it stops inheriting the frontier model."; Verify = "`ax dispatches --candidates` no longer lists this class."; source `ax dispatches class=${routing_match.classId}`; no inline_action. Dedupe by `routing_match.classId` (keep highest savings per class).

`skillHygieneCards`: title `Classify skill ${name}`; evidence `${invocations} invocations, no role`; bonus `log2(invocations)`; link `/skills`; brief Ask = "Run `ax skills classify ${name}` and fill the emitted brief, or `ax skills tag ${name} <role>`."; Verify = "`ax skills by-role` lists it; it leaves the unclassified pool."; source `ax skills classify candidate=${name}`; inline_action `{ type: "decide", sig: null, skill: name, suggested_verdict: null }`.

All builders: sort by impact desc, cap at `PER_SOURCE_CAP`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/axctl/src/dashboard/next-actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dashboard/next-actions.ts apps/axctl/src/dashboard/next-actions.test.ts
git commit -m "feat(dashboard): next-action card builders with agent briefs"
```

---

### Task 6: `fetchNextActions` aggregator (fail-open)

**Files:**
- Modify: `apps/axctl/src/dashboard/next-actions.ts` (append)
- Modify: `apps/axctl/src/dashboard/next-actions.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to the test file; reuse the `makeMockDb` pattern from Task 3 - but here stub at the *source-fn* level is impossible since they're module imports, so test via a poisoned DB layer asserting fail-open)

```ts
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { fetchNextActions } from "./next-actions.ts";

describe("fetchNextActions", () => {
    test("a failing source degrades to a note, never a defect", async () => {
        const stub: SurrealClientShape = {
            query: (_sql: string) => Effect.fail(new Error("db down")),
        } as unknown as SurrealClientShape;
        const payload = await Effect.runPromise(
            fetchNextActions().pipe(
                Effect.provide(Layer.succeed(SurrealClient, stub)),
            ),
        );
        expect(payload.cards).toEqual([]);
        expect(payload.notes.length).toBeGreaterThanOrEqual(5);
        expect(typeof payload.generatedAt).toBe("string");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/dashboard/next-actions.test.ts`
Expected: FAIL - `fetchNextActions` not exported

- [ ] **Step 3: Implement** (append to `next-actions.ts`)

```ts
import { Effect } from "effect";
import type {
    NextActionsPayload,
    NextActionsSourceNote,
} from "@ax/lib/shared/dashboard-types";
import { fetchSessionChurnSummary } from "../metrics/session-churn.ts";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { fetchSkillHygiene } from "../queries/skill-hygiene.ts";
import { fetchImproveProposals } from "./improve-proposals.ts";
import { fetchToolFailures } from "./tool-failures.ts";

const CHURN_WINDOW_DAYS = 14;
const ROUTING_WINDOW_DAYS = 14;

export const fetchNextActions = Effect.fn("dashboard.fetchNextActions")(function* () {
    const notes: NextActionsSourceNote[] = [];
    const guarded = <A>(
        source: NextActionsSourceNote["source"],
        eff: Effect.Effect<A, unknown, SurrealClient>,
        empty: A,
    ) =>
        eff.pipe(
            Effect.catchAll((err) => {
                notes.push({ source, note: String(err) });
                return Effect.succeed(empty);
            }),
        );

    const [proposals, failures, churn, routing, hygiene] = yield* Effect.all(
        [
            guarded("proposal", fetchImproveProposals(), [] as const),
            guarded("tool_failure", fetchToolFailures(), null),
            guarded(
                "churn",
                fetchSessionChurnSummary({
                    since: new Date(Date.now() - CHURN_WINDOW_DAYS * 86_400_000),
                    limit: 20,
                }),
                null,
            ),
            guarded("routing", fetchDispatchCandidates({ sinceDays: ROUTING_WINDOW_DAYS }), null),
            guarded("skill_hygiene", fetchSkillHygiene({ minInvocations: 3, limit: 10 }), []),
        ],
        { concurrency: 3 },
    );

    const cards = [
        ...proposalCards(proposals),
        ...verdictCards(proposals),
        ...(failures ? toolFailureCards(failures.failures) : []),
        ...(churn ? churnCards(churn) : []),
        ...(routing ? routingCards(routing) : []),
        ...skillHygieneCards(hygiene),
    ].sort((a, b) => b.impact - a.impact);

    return {
        generatedAt: new Date().toISOString(),
        cards,
        notes,
    } satisfies NextActionsPayload;
});
```

Exact signatures of `fetchSessionChurnSummary` / `fetchDispatchCandidates` / `fetchToolFailures`: verify against their source files before writing (`apps/axctl/src/metrics/session-churn.ts:264`, `apps/axctl/src/queries/dispatch-analytics.ts:485`, `apps/axctl/src/dashboard/tool-failures.ts:62`). `FetchSessionChurnInput` may require `project`/`source` keys - pass `null` explicitly if non-optional. Type the `guarded` helper to match the real error channels; run `effect-solutions show error-handling` first.

Note `verdict` source never fails independently (derived from proposals) - that's why the failing-DB test expects ≥5 notes, not 6.

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/dashboard/next-actions.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dashboard/next-actions.ts apps/axctl/src/dashboard/next-actions.test.ts
git commit -m "feat(dashboard): fetchNextActions fail-open aggregator"
```

---

### Task 7: Route + proposal briefs

**Files:**
- Modify: `apps/axctl/src/dashboard/router/routes/improve.ts` (register route)
- Modify: `apps/axctl/src/dashboard/improve-proposals.ts` (attach `brief` to each proposal)
- Test: extend the routes test file beside the others (`apps/axctl/src/dashboard/router/routes/insights.test.ts` shows the pattern)

- [ ] **Step 1: Register the route** - in `improve.ts`'s exported route array, add:

```ts
jsonRoute({
    method: "GET",
    path: "/api/next-actions",
    decode: () => decodeOk(undefined),
    handler: () => fetchNextActions(),
}),
```

(match the file's existing import style for `jsonRoute`/`decodeOk` from `../router.ts`).

- [ ] **Step 2: Attach briefs to `/api/improve` proposals** - in `improve-proposals.ts`, map rows before returning:

```ts
import { renderAgentBrief } from "./agent-brief.ts";

const withBrief = (p: ProposalDto): ProposalDto => ({
    ...p,
    brief: renderAgentBrief({
        title: p.title,
        evidence: `hypothesis: ${p.hypothesis} (seen ${p.frequency}x, confidence ${p.confidence})`,
        ask:
            p.status === "open"
                ? "Review this proposal; if sound, run `ax improve accept` and act on the emitted .ax/tasks brief."
                : "Act on the experiment artifact/task for this proposal.",
        verify: "`ax improve show` reflects the new status; follow the experiment checkpoints.",
        source: `ax improve proposal sig=${p.dedupe_sig}`,
    }),
});
// return (rows).map(withBrief)
```

- [ ] **Step 3: Write the route-match test** - using the `matchRoute` + stub-`RouteInput` pattern from `insights.test.ts:11-16,67-89`:

```ts
import { describe, expect, test } from "bun:test";
import { matchRoute } from "../router.ts";
import { improveRoutes } from "./improve.ts";

describe("/api/next-actions", () => {
    test("GET matches and decodes", () => {
        const match = matchRoute(improveRoutes, "GET", "/api/next-actions");
        expect(match).not.toBeNull();
    });
});
```

(Adapt names to actual exports - `matchRoute` location and the routes array export name; copy what `insights.test.ts` imports.)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test apps/axctl/src/dashboard && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/dashboard/router/routes/improve.ts apps/axctl/src/dashboard/improve-proposals.ts apps/axctl/src/dashboard/router/routes/*.test.ts
git commit -m "feat(dashboard): /api/next-actions route + proposal briefs"
```

---

### Task 8: Synthetic codex-skill filters

**Files:**
- Modify: `apps/axctl/src/queries/project.ts:38-47` (`PROJECT_TOP_SKILLS_SQL`)
- Modify: `apps/axctl/src/cli/skills-classify.ts:34-46` (`buildDefaultSql`)
- Test: `apps/axctl/src/queries/project.test.ts` (extend or create), `apps/axctl/src/cli/skills-classify.test.ts` (extend if exists)

Synthetic provider-tool skills are identified by `dir_path = "(synthetic)"` (writer: `apps/axctl/src/ingest/normalized/transcripts.ts:176-183`; precedent filter: `apps/axctl/src/dashboard/skills-weighted.ts:127-135`).

- [ ] **Step 1: Write failing SQL-shape tests**

```ts
import { describe, expect, test } from "bun:test";
import { PROJECT_TOP_SKILLS_SQL } from "./project.ts";

describe("PROJECT_TOP_SKILLS_SQL", () => {
    test("excludes synthetic provider-tool skills", () => {
        expect(PROJECT_TOP_SKILLS_SQL).toContain('dir_path = "(synthetic)"');
        expect(PROJECT_TOP_SKILLS_SQL).toContain("out NOT IN");
    });
});
```

(Export the constant if it isn't already; same-style test for `buildDefaultSql()` asserting it contains `dir_path != "(synthetic)"`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/axctl/src/queries/project.test.ts`
Expected: FAIL

- [ ] **Step 3: Apply filters**

`PROJECT_TOP_SKILLS_SQL` - add one condition (single statement, `out` is an edge field, no deref):

```sql
AND out NOT IN (SELECT VALUE id FROM skill WHERE dir_path = "(synthetic)")
```

`buildDefaultSql()` in `skills-classify.ts` - `FROM skill` query, direct field, add to the WHERE:

```sql
AND dir_path != "(synthetic)"
```

- [ ] **Step 4: Run tests + manual sanity** (daemon must be running)

Run: `bun test apps/axctl/src/queries apps/axctl/src/cli/skills-classify.test.ts 2>/dev/null; bun run typecheck`
Then: `./apps/axctl/bin/axctl skills classify --dry-run 2>/dev/null | head -20` - `codex:*` names must be gone.
Expected: PASS; no `codex:` rows

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/project.ts apps/axctl/src/queries/project.test.ts apps/axctl/src/cli/skills-classify.ts
git commit -m "fix(queries): exclude synthetic provider-tool skills from skill surfaces"
```

---

### Task 9: Studio API client + CopyButton

**Files:**
- Modify: `apps/studio/src/api.ts`
- Create: `apps/studio/src/components/copy-button.tsx`

No frontend test infra exists; verification is typecheck + build + manual.

- [ ] **Step 1: Add the client method** - in the `api` object (`apps/studio/src/api.ts`, near `improve:` at ~line 369):

```ts
nextActions: (): Promise<NextActionsPayload> => jsonFetch("/api/next-actions"),
```

(add `NextActionsPayload` to the existing `@ax/lib/shared/dashboard-types` type import.)

- [ ] **Step 2: Create CopyButton**

```tsx
import { useState } from "react";

export function CopyButton({
    text,
    label = "Copy agent brief",
}: {
    readonly text: string;
    readonly label?: string;
}) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="badge review"
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                });
            }}
        >
            {copied ? "Copied ✓" : label}
        </button>
    );
}
```

- [ ] **Step 3: Build + typecheck studio** (studio typecheck needs a prior build - repo rule)

Run: `bunx turbo run build && (cd apps/studio && bun run typecheck)`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/api.ts apps/studio/src/components/copy-button.tsx
git commit -m "feat(studio): nextActions client + CopyButton"
```

---

### Task 10: NextActionsPanel component

**Files:**
- Create: `apps/studio/src/components/next-actions-panel.tsx`

- [ ] **Step 1: Implement the panel**

```tsx
import { useQuery } from "@tanstack/react-query";
import type { NextActionCard } from "@ax/lib/shared/dashboard-types";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import { CopyButton } from "./copy-button.tsx";

export interface NextActionsHandlers {
    readonly onAccept: (sig: string) => void;
    readonly onVerdict: (sig: string, verdict: string) => void;
    readonly pending: boolean;
}

const KIND_LABEL: Record<string, string> = {
    proposal: "proposal",
    verdict: "verdict due",
    tool_failure: "tool failure",
    churn: "churn",
    routing: "routing $",
    skill_hygiene: "skill hygiene",
};

export function NextActionsPanel({ handlers }: { readonly handlers: NextActionsHandlers }) {
    const query = useQuery({ queryKey: ["next-actions"], queryFn: () => api.nextActions() });
    if (query.isLoading) return <div className="loading">Loading next actions…</div>;
    if (query.error) return <div className="error">next-actions: {String(query.error)}</div>;
    const cards = query.data?.cards ?? [];
    if (cards.length === 0) {
        return <div className="empty">Nothing actionable right now - loop is clean.</div>;
    }
    return (
        <div className="next-actions">
            {cards.map((card) => (
                <NextActionCardView key={card.id} card={card} handlers={handlers} />
            ))}
            {(query.data?.notes.length ?? 0) > 0 ? (
                <div className="meta">
                    {query.data!.notes.map((n) => `${n.source}: unavailable`).join(" · ")}
                </div>
            ) : null}
        </div>
    );
}

function NextActionCardView({
    card,
    handlers,
}: {
    readonly card: NextActionCard;
    readonly handlers: NextActionsHandlers;
}) {
    const a = card.inline_action;
    return (
        <article className="panel next-action-card">
            <header>
                <span className={`badge ${card.kind === "verdict" ? "archive" : "review"}`}>
                    {KIND_LABEL[card.kind] ?? card.kind}
                </span>
                <h4 style={{ margin: 0 }}>{card.title}</h4>
            </header>
            <p className="meta">{card.evidence}</p>
            <div className="actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <CopyButton text={card.brief} />
                {a?.type === "accept" && a.sig ? (
                    <button type="button" className="badge keep" disabled={handlers.pending}
                        onClick={() => handlers.onAccept(a.sig!)}>Accept & scaffold</button>
                ) : null}
                {a?.type === "verdict" && a.sig && a.suggested_verdict ? (
                    <button type="button" className="badge keep" disabled={handlers.pending}
                        onClick={() => handlers.onVerdict(a.sig!, a.suggested_verdict!)}>
                        Lock: {a.suggested_verdict}</button>
                ) : null}
                {card.link ? <Link to={card.link} className="badge review">details →</Link> : null}
            </div>
        </article>
    );
}
```

Check how other studio components import `Link` (some use plain `<a>` with router helpers) - match the codebase.

- [ ] **Step 2: Build + typecheck**

Run: `bunx turbo run build && (cd apps/studio && bun run typecheck)`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/components/next-actions-panel.tsx
git commit -m "feat(studio): NextActionsPanel"
```

---

### Task 11: DecisionsSection extraction

**Files:**
- Create: `apps/studio/src/components/decisions-section.tsx`
- Modify: `apps/studio/src/routes/decisions.tsx`

- [ ] **Step 1: Move, don't rewrite** - cut the entire body of `DecisionsRoute` (`apps/studio/src/routes/decisions.tsx`, the decision-log table, TanStack query key `["decisions"]`, the keep/review/archive mutations and cache patching) into a new exported component:

```tsx
export function DecisionsSection() {
    /* moved verbatim from DecisionsRoute */
}
```

`decisions.tsx` becomes:

```tsx
import { DecisionsSection } from "../components/decisions-section.tsx";

export function DecisionsRoute() {
    return <DecisionsSection />;
}
```

- [ ] **Step 2: Build + typecheck**

Run: `bunx turbo run build && (cd apps/studio && bun run typecheck)`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/components/decisions-section.tsx apps/studio/src/routes/decisions.tsx
git commit -m "refactor(studio): extract DecisionsSection from decisions route"
```

---

### Task 12: Improve route - three zones

**Files:**
- Modify: `apps/studio/src/routes/improve.tsx`

- [ ] **Step 1: Wire the zones** - in `ImproveRoute` (mutations for accept/verdict already exist at lines 63-81):

1. Render `<NextActionsPanel handlers={{ onAccept: (sig) => acceptMutation.mutate(sig), onVerdict: (sig, v) => verdictMutation.mutate({ sig, verdict: v }), pending: acceptMutation.isPending || verdictMutation.isPending }} />` directly under the `<header>` (zone 1).
2. Keep the proposals grid as zone 2; in `ProposalDetail`, add next to the action buttons: `{proposal.brief ? <CopyButton text={proposal.brief} /> : null}`.
3. Append zone 3 at the bottom:

```tsx
<details style={{ marginTop: 24 }}>
    <summary><h3 style={{ display: "inline" }}>Decision log</h3></summary>
    <DecisionsSection />
</details>
```

4. Re-rank the proposals table by confidence × frequency (spec zone 2) - replace the plain `filtered` memo result with a sorted copy:

```ts
const CONF_W: Record<string, number> = { high: 3, medium: 2, low: 1 };
const score = (p: ProposalDto) => (CONF_W[p.confidence] ?? 1) * Math.log2(p.frequency + 1);
// inside the useMemo, after filtering:
return [...matches].sort((a, b) => score(b) - score(a));
```

(update the filter-bar hint text "Ranked by frequency" → "Ranked by confidence × frequency".)

5. Invalidate `["next-actions"]` alongside `["improve"]` in `onActionResult` (line 56) so inline actions refresh the panel:

```ts
queryClient.invalidateQueries({ queryKey: ["improve"] });
queryClient.invalidateQueries({ queryKey: ["next-actions"] });
```

- [ ] **Step 2: Build + typecheck**

Run: `bunx turbo run build && (cd apps/studio && bun run typecheck)`
Expected: PASS

- [ ] **Step 3: Manual verification** (daemon from source: `./apps/axctl/bin/axctl serve`)

- Open the studio Improve tab → Next Actions panel renders cards (or clean-loop empty state).
- Click "Copy agent brief" → paste into a scratch buffer → matches the brief format.
- Accept on a proposal card → panel and table both refresh.
- `curl -s localhost:<port>/api/next-actions | jq '.cards[0]'` → card JSON with `brief` string.

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/routes/improve.tsx
git commit -m "feat(studio): improve route three zones - next actions, proposals, decision log"
```

---

### Task 13: Full gate + PR

- [ ] **Step 1: Full test + typecheck**

Run: `bun test && bun run typecheck && bunx turbo run build`
Expected: PASS across repo

- [ ] **Step 2: Push branch + open PR**

```bash
git push -u origin worktree-improve-first-dashboard-spec
gh pr create --title "feat(dashboard): improve-first - next actions panel with agent briefs (PR1)" --body "$(cat <<'EOF'
Implements PR1 of docs/superpowers/specs/2026-06-12-improve-first-dashboard-design.md:
- /api/next-actions: ranked action cards from 6 sources, fail-open, server-rendered agent briefs
- Improve route: Next Actions panel + proposal copy-brief + embedded decision log
- Synthetic codex:* skills excluded from project top-skills + classify candidates

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Merge only at `mergeStateStatus: CLEAN` (repo rule).
