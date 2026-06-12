import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type {
    NextActionCard,
    ProposalDto,
    ToolFailureEntry,
} from "@ax/lib/shared/dashboard-types";
import type { SessionChurnSummary } from "../metrics/session-churn.ts";
import type { CandidatesResult, CandidateRow } from "../queries/dispatch-analytics.ts";
import type { SkillHygieneRow } from "../queries/skill-hygiene.ts";
import {
    churnCards,
    housekeepingCards,
    fetchNextActions,
    proposalCards,
    routingCards,
    skillHygieneCards,
    toolFailureCards,
    verdictCards,
} from "./next-actions.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openProposal = (overrides: Partial<ProposalDto> = {}): ProposalDto => ({
    id: "proposal:abc",
    form: "skill",
    title: "Use superpowers:brainstorming before building",
    hypothesis: "Agents skip brainstorming and produce wrong artifacts",
    dedupe_sig: "abc123",
    frequency: 8,
    confidence: "high",
    status: "open",
    reject_reason: null,
    created_at: "2026-06-01T00:00:00Z",
    experiment: null,
    ...overrides,
});

const acceptedWithExperiment = (withCheckpoint: boolean): ProposalDto => ({
    id: "proposal:def",
    form: "guidance",
    title: "Always read CLAUDE.md before editing",
    hypothesis: "Agents miss guidance",
    dedupe_sig: "def456",
    frequency: 5,
    confidence: "medium",
    status: "accepted",
    reject_reason: null,
    created_at: "2026-06-01T00:00:00Z",
    experiment: {
        id: "exp:1",
        artifact_path: null,
        status: "scaffolded",
        task_path: null,
        locked_verdict: null,
        created_at: "2026-06-02T00:00:00Z",
        scaffolded_at: "2026-06-02T00:00:00Z",
        latest_checkpoint: withCheckpoint
            ? {
                  kind: "+3s",
                  suggested: "adopted",
                  user_verdict: null,
                  measured: null,
                  observed_at: "2026-06-03T00:00:00Z",
              }
            : null,
    },
});

const lockedExperimentProposal = (): ProposalDto => ({
    id: "proposal:locked",
    form: "skill",
    title: "Locked verdict proposal",
    hypothesis: "Already decided",
    dedupe_sig: "locked789",
    frequency: 3,
    confidence: "low",
    status: "accepted",
    reject_reason: null,
    created_at: "2026-06-01T00:00:00Z",
    experiment: {
        id: "exp:locked",
        artifact_path: null,
        status: "scaffolded",
        task_path: null,
        locked_verdict: "adopted",    // already locked → should NOT produce a verdictCard
        created_at: "2026-06-02T00:00:00Z",
        scaffolded_at: "2026-06-02T00:00:00Z",
        latest_checkpoint: null,
    },
});

const toolFailure = (overrides: Partial<ToolFailureEntry> = {}): ToolFailureEntry => ({
    label: "bun test",
    failure_count: 20,
    last_seen: "2026-06-10T10:00:00Z",
    last_error_text: "FAIL src/foo.test.ts",
    last_project: "ax",
    distinct_sessions: 4,
    total_calls: 50,
    failure_rate: 0.4,
    exit_codes: [1],
    recommendation: "fix",
    recommendation_reason: "High failure rate",
    ...overrides,
});

const churnSummary = (rows: SessionChurnSummary["hotSessions"]): SessionChurnSummary => ({
    generatedAt: "2026-06-12T00:00:00Z",
    filters: { since: null, project: null, source: null, limit: 10 },
    aggregates: [],
    hotSessions: rows,
});

const churnRow = (
    sessionId: string,
    repairAdded: number,
    repairRemoved: number,
    landedAdded: number,
    landedRemoved: number,
    verificationFailures: number,
): SessionChurnSummary["hotSessions"][number] => ({
    session: sessionId,
    source: "claude",
    taskLabel: "some task",
    landedLinesAdded: landedAdded,
    landedLinesRemoved: landedRemoved,
    editLinesAdded: repairAdded + landedAdded,
    editLinesRemoved: repairRemoved + landedRemoved,
    repairLinesAdded: repairAdded,
    repairLinesRemoved: repairRemoved,
    editEvents: 5,
    verificationFailures,
    verificationPasses: 1,
    episodes: verificationFailures > 0 ? 1 : 0,
    passedEpisodes: 0,
    topCheck: "test",
});

const makeCandidate = (
    classId: string,
    savings: number,
    description?: string,
): CandidateRow => ({
    ts: "2026-06-10T00:00:00Z",
    parent_id: "sess-parent",
    child_id: "sess-child",
    agent_type: null,
    description: description ?? `${classId} dispatch`,
    dispatch_model: "inherit",
    child_model: "claude-fable-3-7",
    child_cost_usd: savings + 0.01,
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_read_tokens: 0,
    cache_create_tokens: 0,
    routing_match: {
        classId,
        suggest: "sonnet",
        reason: "test reason",
        source: "description",
    },
    suggested_model: "claude-sonnet-4-6",
    est_savings_usd: savings,
});

const candidatesResult = (candidates: CandidateRow[]): CandidatesResult => ({
    candidates,
    total_est_savings_usd: candidates.reduce((s, c) => s + c.est_savings_usd, 0),
    top_classes: [],
});

// ---------------------------------------------------------------------------
// proposalCards
// ---------------------------------------------------------------------------

describe("proposalCards", () => {
    test("filters out non-open proposals", () => {
        const proposals = [
            openProposal({ status: "open" }),
            openProposal({ status: "accepted", dedupe_sig: "zzz", title: "accepted one" }),
            openProposal({ status: "rejected", dedupe_sig: "yyy", title: "rejected one" }),
        ];
        const cards = proposalCards(proposals);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("proposal:abc123");
    });

    test("inline action is accept type with correct sig", () => {
        const cards = proposalCards([openProposal()]);
        expect(cards[0]!.inline_action).toEqual({
            type: "accept",
            sig: "abc123",
            skill: null,
            suggested_verdict: null,
        });
    });

    test("brief contains evidence, ask, and verify text", () => {
        const cards = proposalCards([openProposal()]);
        const brief = cards[0]!.brief;
        expect(brief).toContain("Use superpowers:brainstorming before building");
        expect(brief).toContain("ax improve accept");
        expect(brief).toContain("ax improve show");
        expect(brief).toContain("abc123");
    });

    test("impact is within KIND_WEIGHT.proposal range (80 to 89)", () => {
        const cards = proposalCards([openProposal()]);
        const impact = cards[0]!.impact;
        expect(impact).toBeGreaterThanOrEqual(80);
        expect(impact).toBeLessThanOrEqual(89);
    });

    test("high confidence has higher impact than low confidence", () => {
        const high = proposalCards([openProposal({ confidence: "high", dedupe_sig: "h1" })]);
        const low = proposalCards([openProposal({ confidence: "low", dedupe_sig: "l1" })]);
        expect(high[0]!.impact).toBeGreaterThan(low[0]!.impact);
    });

    test("PER_SOURCE_CAP: 7 inputs → 5 cards", () => {
        const proposals = Array.from({ length: 7 }, (_, i) =>
            openProposal({ dedupe_sig: `sig${i}`, title: `Proposal ${i}` }),
        );
        const cards = proposalCards(proposals);
        expect(cards).toHaveLength(5);
    });

    test("cards sorted by impact descending", () => {
        const proposals = [
            openProposal({ confidence: "low", frequency: 1, dedupe_sig: "l1" }),
            openProposal({ confidence: "high", frequency: 20, dedupe_sig: "h1" }),
            openProposal({ confidence: "medium", frequency: 5, dedupe_sig: "m1" }),
        ];
        const cards = proposalCards(proposals);
        for (let i = 1; i < cards.length; i++) {
            expect(cards[i - 1]!.impact).toBeGreaterThanOrEqual(cards[i]!.impact);
        }
    });
});

// ---------------------------------------------------------------------------
// verdictCards
// ---------------------------------------------------------------------------

describe("impactChip", () => {
    test("routing hypothesis yields a $ chip", () => {
        const card = proposalCards([
            openProposal({
                form: "hook",
                hypothesis: "71 model-less dispatches; est $296.84 redirectable. Top classes: x",
            }),
        ])[0]!;
        expect(card.impact_chip).toBe("~$296.84 redirectable");
    });

    test("guidance frequency yields a recurring chip; freq 1 yields none", () => {
        const a = proposalCards([openProposal({ form: "guidance", frequency: 9 })])[0]!;
        expect(a.impact_chip).toBe("9x recurring");
        const b = proposalCards([openProposal({ form: "guidance", frequency: 1 })])[0]!;
        expect(b.impact_chip).toBeNull();
    });
});

describe("fixKind", () => {
    test("names the mechanism per form, guidance names its file target", () => {
        expect(proposalCards([openProposal({ form: "skill" })])[0]!.fix_kind).toBe("new skill");
        expect(proposalCards([openProposal({ form: "hook" })])[0]!.fix_kind).toBe("new hook");
        expect(
            proposalCards([
                openProposal({
                    form: "guidance",
                    guidance_payload: { file_target: "CLAUDE.md", section: null, suggested_text: "x" },
                }),
            ])[0]!.fix_kind,
        ).toBe("edit CLAUDE.md");
    });
});

describe("verdictCards", () => {
    test("only accepted proposals with experiment and no locked_verdict", () => {
        const proposals = [
            openProposal({ status: "open" }),
            acceptedWithExperiment(false),
            lockedExperimentProposal(),
            // accepted but no experiment
            openProposal({ status: "accepted", dedupe_sig: "no-exp" }),
        ];
        const cards = verdictCards(proposals);
        // Only acceptedWithExperiment (no checkpoint, no locked verdict)
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("verdict:def456");
    });

    test("suggested_verdict passthrough when checkpoint exists", () => {
        const cards = verdictCards([acceptedWithExperiment(true)]);
        expect(cards[0]!.inline_action).toEqual({
            type: "verdict",
            sig: "def456",
            skill: null,
            suggested_verdict: "adopted",
        });
    });

    test("suggested_verdict is null when no checkpoint", () => {
        const cards = verdictCards([acceptedWithExperiment(false)]);
        expect(cards[0]!.inline_action!.suggested_verdict).toBeNull();
    });

    test("brief mentions the suggested verdict when present", () => {
        const cards = verdictCards([acceptedWithExperiment(true)]);
        expect(cards[0]!.brief).toContain("adopted");
    });

    test("link is null", () => {
        const cards = verdictCards([acceptedWithExperiment(false)]);
        expect(cards[0]!.link).toBeNull();
    });

    test("title contains 'Lock verdict'", () => {
        const cards = verdictCards([acceptedWithExperiment(false)]);
        expect(cards[0]!.title).toMatch(/^Lock verdict:/);
    });
});

// ---------------------------------------------------------------------------
// toolFailureCards
// ---------------------------------------------------------------------------

describe("toolFailureCards", () => {
    test("filters out non-fix recommendations", () => {
        const failures = [
            toolFailure({ recommendation: "fix" }),
            toolFailure({ label: "curl", recommendation: "watch" }),
            toolFailure({ label: "npm run lint", recommendation: "ignore" }),
        ];
        const cards = toolFailureCards(failures);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("tool_failure:bun test");
    });

    test("link is /tools", () => {
        const cards = toolFailureCards([toolFailure()]);
        expect(cards[0]!.link).toBe("/tools");
    });

    test("evidence includes failure_count, distinct_sessions, and exit_codes", () => {
        const cards = toolFailureCards([toolFailure()]);
        expect(cards[0]!.evidence).toContain("20 failures");
        expect(cards[0]!.evidence).toContain("4 sessions");
        expect(cards[0]!.evidence).toContain("1");
    });

    test("inline_action is null", () => {
        const cards = toolFailureCards([toolFailure()]);
        expect(cards[0]!.inline_action).toBeNull();
    });

    test("brief includes label and last_error_text", () => {
        const cards = toolFailureCards([toolFailure()]);
        expect(cards[0]!.brief).toContain("bun test");
        expect(cards[0]!.brief).toContain("FAIL src/foo.test.ts");
    });

    test("PER_SOURCE_CAP: 7 inputs → 5 cards", () => {
        const failures = Array.from({ length: 7 }, (_, i) =>
            toolFailure({ label: `tool-${i}`, recommendation: "fix" }),
        );
        const cards = toolFailureCards(failures);
        expect(cards).toHaveLength(5);
    });
});

// ---------------------------------------------------------------------------
// churnCards
// ---------------------------------------------------------------------------

describe("churnCards", () => {
    test("repair-ratio outlier triggers card", () => {
        // repair = 100+50 = 150, landed = 10+10 = 20. 150 >= 100 && 150 >= 0.5*20=10 ✓
        const summary = churnSummary([
            churnRow("sess-repair", 100, 50, 10, 10, 2),
        ]);
        const cards = churnCards(summary);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("churn:sess-repair");
    });

    test("verificationFailures >= 5 triggers card", () => {
        // repair = 0, but 5 failures
        const summary = churnSummary([
            churnRow("sess-fails", 0, 0, 100, 50, 5),
        ]);
        const cards = churnCards(summary);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("churn:sess-fails");
    });

    test("non-outlier session excluded", () => {
        // repair = 30, landed = 200. 30 < 100 AND fails = 2 < 5 → not an outlier
        const summary = churnSummary([
            churnRow("sess-normal", 15, 15, 100, 100, 2),
        ]);
        const cards = churnCards(summary);
        expect(cards).toHaveLength(0);
    });

    test("evidence contains session, repair LOC, landed LOC, failures", () => {
        const summary = churnSummary([
            churnRow("sess-repair", 100, 50, 10, 10, 2),
        ]);
        const cards = churnCards(summary);
        const evidence = cards[0]!.evidence;
        expect(evidence).toContain("sess-repair");
        expect(evidence).toContain("150"); // repair = 100+50
        expect(evidence).toContain("20");  // landed = 10+10
        expect(evidence).toContain("2");   // verificationFailures
    });

    test("link is /sessions/:id", () => {
        const summary = churnSummary([
            churnRow("sess-repair", 100, 50, 10, 10, 2),
        ]);
        const cards = churnCards(summary);
        expect(cards[0]!.link).toBe("/sessions/sess-repair");
    });

    test("inline_action is null", () => {
        const summary = churnSummary([
            churnRow("sess-repair", 100, 50, 10, 10, 2),
        ]);
        const cards = churnCards(summary);
        expect(cards[0]!.inline_action).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// routingCards
// ---------------------------------------------------------------------------

describe("routingCards", () => {
    test("filters out candidates with est_savings_usd < 0.01", () => {
        const result = candidatesResult([
            makeCandidate("search-locate", 0.005),
            makeCandidate("research", 0.02),
        ]);
        const cards = routingCards(result);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("routing:research");
    });

    test("class dedupe: two candidates same class → 1 card with higher savings", () => {
        const result = candidatesResult([
            makeCandidate("search-locate", 0.05, "first dispatch"),
            makeCandidate("search-locate", 0.12, "second dispatch"),
        ]);
        const cards = routingCards(result);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.id).toBe("routing:search-locate");
        // Should keep the higher savings one (0.12)
        expect(cards[0]!.evidence).toContain("$0.12");
    });

    test("evidence includes savings, description, and child_model", () => {
        const result = candidatesResult([makeCandidate("research", 0.05)]);
        const cards = routingCards(result);
        expect(cards[0]!.evidence).toContain("$0.05");
        expect(cards[0]!.evidence).toContain("research dispatch");
        expect(cards[0]!.evidence).toContain("claude-fable-3-7");
    });

    test("title mentions classId and suggested_model", () => {
        const result = candidatesResult([makeCandidate("research", 0.05)]);
        const cards = routingCards(result);
        expect(cards[0]!.title).toContain("research");
        expect(cards[0]!.title).toContain("claude-sonnet-4-6");
    });

    test("link is null", () => {
        const result = candidatesResult([makeCandidate("research", 0.05)]);
        const cards = routingCards(result);
        expect(cards[0]!.link).toBeNull();
    });

    test("inline_action is null", () => {
        const result = candidatesResult([makeCandidate("research", 0.05)]);
        const cards = routingCards(result);
        expect(cards[0]!.inline_action).toBeNull();
    });

    test("null description and child_model render as 'unknown', never 'null'", () => {
        const candidate: CandidateRow = {
            ...makeCandidate("research", 0.05),
            description: null,
            child_model: null,
        };
        const cards = routingCards(candidatesResult([candidate]));
        expect(cards[0]!.evidence).toContain("unknown");
        expect(cards[0]!.evidence).not.toContain("null");
        expect(cards[0]!.brief).not.toContain(" null");
    });
});

// ---------------------------------------------------------------------------
// skillHygieneCards
// ---------------------------------------------------------------------------

describe("skillHygieneCards", () => {
    test("decide inline_action with correct skill name", () => {
        const rows: SkillHygieneRow[] = [{ name: "superpowers:brainstorming", invocations: 15 }];
        const cards = skillHygieneCards(rows);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.inline_action).toEqual({
            type: "decide",
            sig: null,
            skill: "superpowers:brainstorming",
            suggested_verdict: null,
        });
    });

    test("id format is skill_hygiene:name", () => {
        const rows: SkillHygieneRow[] = [{ name: "my-skill", invocations: 10 }];
        const cards = skillHygieneCards(rows);
        expect(cards[0]!.id).toBe("skill_hygiene:my-skill");
    });

    test("evidence includes invocations", () => {
        const rows: SkillHygieneRow[] = [{ name: "my-skill", invocations: 42 }];
        const cards = skillHygieneCards(rows);
        expect(cards[0]!.evidence).toContain("42 invocations");
    });

    test("link is /skills", () => {
        const rows: SkillHygieneRow[] = [{ name: "my-skill", invocations: 10 }];
        const cards = skillHygieneCards(rows);
        expect(cards[0]!.link).toBe("/skills");
    });

    test("brief asks to run classify or tag", () => {
        const rows: SkillHygieneRow[] = [{ name: "my-skill", invocations: 10 }];
        const cards = skillHygieneCards(rows);
        expect(cards[0]!.brief).toContain("ax skills classify my-skill");
        expect(cards[0]!.brief).toContain("ax skills tag my-skill");
    });

    test("PER_SOURCE_CAP: 7 inputs → 5 cards", () => {
        const rows: SkillHygieneRow[] = Array.from({ length: 7 }, (_, i) => ({
            name: `skill-${i}`,
            invocations: 10 + i,
        }));
        const cards = skillHygieneCards(rows);
        expect(cards).toHaveLength(5);
    });

    test("cards sorted by impact descending", () => {
        const rows: SkillHygieneRow[] = [
            { name: "rare", invocations: 3 },
            { name: "common", invocations: 100 },
            { name: "mid", invocations: 20 },
        ];
        const cards = skillHygieneCards(rows);
        for (let i = 1; i < cards.length; i++) {
            expect(cards[i - 1]!.impact).toBeGreaterThanOrEqual(cards[i]!.impact);
        }
    });
});

// ---------------------------------------------------------------------------
// Verify all card shapes satisfy NextActionCard
// ---------------------------------------------------------------------------

test("all builders return NextActionCard[] typed arrays", () => {
    // Type check via satisfies at construction - if it compiles, shapes match.
    const pc: NextActionCard[] = proposalCards([openProposal()]);
    const vc: NextActionCard[] = verdictCards([acceptedWithExperiment(true)]);
    const tc: NextActionCard[] = toolFailureCards([toolFailure()]);
    const cc: NextActionCard[] = churnCards(
        churnSummary([churnRow("sess-x", 100, 50, 10, 10, 2)]),
    );
    const rc: NextActionCard[] = routingCards(candidatesResult([makeCandidate("research", 0.05)]));
    const sc: NextActionCard[] = skillHygieneCards([{ name: "x", invocations: 10 }]);

    // All present (guards against tree-shaking)
    expect([pc, vc, tc, cc, rc, sc].every(Array.isArray)).toBe(true);
});

// ---------------------------------------------------------------------------
// fetchNextActions aggregator
// ---------------------------------------------------------------------------

describe("housekeepingCards", () => {
    test("one card when stale proposals exist, none when clean", () => {
        expect(housekeepingCards([])).toHaveLength(0);
        const cards = housekeepingCards([
            { id: "proposal:a", title: "Old A", dedupe_sig: "a", form: "skill", updated_at: null },
            { id: "proposal:b", title: "Old B", dedupe_sig: "b", form: "guidance", updated_at: null },
        ]);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.kind).toBe("housekeeping");
        expect(cards[0]!.title).toContain("2 stale proposals");
        expect(cards[0]!.brief).toContain("ax improve housekeep");
        expect(cards[0]!.fix_kind).toContain("housekeep");
    });
});

describe("fetchNextActions", () => {
    test("a failing source degrades to a note, never a defect", async () => {
        const stub: SurrealClientShape = {
            query: (_sql: string) => Effect.fail(new Error("db down") as never),
            // biome-ignore lint: other methods not needed
        } as unknown as SurrealClientShape;
        const layer = Layer.succeed(SurrealClient, stub);

        const payload = await Effect.runPromise(
            fetchNextActions().pipe(Effect.provide(layer)),
        );

        expect(payload.cards).toEqual([]);
        // tool_failure uses runQuery (internal fail-open), so it does NOT add a note
        // on DB failure - it silently returns []. The other 4 sources use db.query
        // directly and do add notes. Exact set: if runQuery's internal swallow ever
        // changes and tool_failure starts noting, this surfaces it.
        expect(new Set(payload.notes.map((n) => n.source))).toEqual(
            new Set(["proposal", "churn", "routing", "skill_hygiene", "housekeeping"]),
        );
        expect(typeof payload.generatedAt).toBe("string");
    });

    test("a hanging source (Effect.never) is timed out and noted; all 6 sources noted", async () => {
        // db.query returns Effect.never - simulates a hung DB / slow query.
        // runQuery's internal Effect.catch only catches DbError failures; it does NOT
        // prevent fiber interruption from timeoutOrElse. The timeout fires, the
        // orElse failure propagates to our guarded catch, and ALL 6 sources add a
        // note - including tool_failure which normally swallows DB errors internally.
        const stub: SurrealClientShape = {
            query: (_sql: string) => Effect.never,
            // biome-ignore lint: other methods not needed
        } as unknown as SurrealClientShape;
        const layer = Layer.succeed(SurrealClient, stub);

        const payload = await Effect.runPromise(
            fetchNextActions({ sourceTimeoutMs: 50 }).pipe(Effect.provide(layer)),
        );

        expect(payload.cards).toEqual([]);
        // All 6 direct-DB sources time out; tool_failure is also noted because
        // timeoutOrElse interrupts the fiber before runQuery's internal swallow fires.
        expect(new Set(payload.notes.map((n) => n.source))).toEqual(
            new Set(["proposal", "tool_failure", "churn", "routing", "skill_hygiene", "housekeeping"]),
        );
        // At least one note should mention timed out (two words - our orElse uses "timed out after Nms")
        expect(payload.notes.some((n) => /timed out/i.test(n.note))).toBe(true);
        expect(typeof payload.generatedAt).toBe("string");
    });
});
