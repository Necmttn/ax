import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeTestCacheRead, type TestCacheOptions } from "@ax/lib/testing/cache";
import type { CacheRead, CacheReadError } from "@ax/lib/duckdb/seam";
import {
    COST_TOL,
    fetchSessionMetrics,
    findVariantSession,
    parseSparBrief,
    parseSparScore,
    renderSparBrief,
    renderSparReport,
    REPAIR_TOL,
    scoreSpar,
    stampSparSession,
} from "./spar.ts";
import type { SparBrief, SparMetrics } from "./spar.ts";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";

const baseMetrics = (o: Partial<SparMetrics> = {}): SparMetrics => ({
    costUsd: 1.20,
    turns: 18,
    wallMs: 600_000,
    repairLines: 40,
    episodes: 3,
    landed: true,
    ...o,
});

const brief: SparBrief = {
    id: "ab12cd34-2026-06-13",
    createdAt: "2026-06-13T10:00:00.000Z",
    prompt: "Add the foo endpoint",
    parentSha: "ab12cd34",
    baselineSession: "session:base",
    worktree: ".claude/worktrees/dojo-spar-ab12cd34-2026-06-13",
    baseline: baseMetrics(),
    baselineIsSubagent: false,
    delta: "skill: tdd ON",
};

describe("scoreSpar", () => {
    test("win: cheaper + still landed + repair not worse", () => {
        const s = scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.80, repairLines: 30 }));
        expect(s.verdict).toBe("win");
        expect(s.deltas.costUsd).toBeCloseTo(-0.40, 5);
        expect(s.deltas.repairLines).toBe(-10);
    });
    test("regression: lost landed", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ landed: false })).verdict).toBe("regression");
    });
    test("regression: clearly costlier", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ costUsd: 2.0 })).verdict).toBe("regression");
    });
    test("mixed: cheaper but more repair", () => {
        expect(scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.9, repairLines: 80 })).verdict).toBe("mixed");
    });
    test("tolerances: COST_TOL gates the win, REPAIR_TOL flips win -> mixed", () => {
        const base = brief.baseline;
        // cost win inside the COST_TOL noise band -> not a win (mixed)
        const noise = scoreSpar(base, baseMetrics({ costUsd: base.costUsd! - (COST_TOL / 2) }));
        expect(noise.verdict).toBe("mixed");
        // cost win clearly past COST_TOL, repair unchanged -> win
        const win = scoreSpar(base, baseMetrics({ costUsd: base.costUsd! - (COST_TOL * 4) }));
        expect(win.verdict).toBe("win");
        // same clear cost win, but repair past REPAIR_TOL -> mixed (tradeoff)
        const tradeoff = scoreSpar(base, baseMetrics({
            costUsd: base.costUsd! - (COST_TOL * 4),
            repairLines: base.repairLines + REPAIR_TOL + 1,
        }));
        expect(tradeoff.verdict).toBe("mixed");
    });
});

describe("renderSparBrief / parseSparBrief roundtrip", () => {
    test("brief renders frontmatter + JSON baseline block and parses back", () => {
        const md = renderSparBrief(brief);
        expect(md).toContain("# Spar: ab12cd34-2026-06-13");
        expect(md).toContain("git worktree add");
        expect(md).toContain(brief.prompt);
        const parsed = parseSparBrief(md);
        expect(parsed?.id).toBe(brief.id);
        expect(parsed?.baseline.costUsd).toBe(1.20);
        expect(parsed?.parentSha).toBe("ab12cd34");
        expect(parsed?.baselineIsSubagent).toBe(false);
    });
    test("subagent baseline renders a caution and roundtrips the flag", () => {
        const md = renderSparBrief({ ...brief, baselineIsSubagent: true });
        expect(md).toContain("baseline is a SUBAGENT session");
        expect(md).toContain("baseline_is_subagent: true");
        expect(parseSparBrief(md)?.baselineIsSubagent).toBe(true);
    });
    test("worktreeAbs puts the absolute path in the command but keeps frontmatter relative", () => {
        const md = renderSparBrief(brief, `/Users/x/ax/${brief.worktree}`);
        // The command the agent runs must be absolute (so a run from inside a
        // linked worktree still lands the variant at the main-root path).
        expect(md).toContain(`git worktree add /Users/x/ax/${brief.worktree} -b dojo/spar-${brief.id}`);
        // ...but the frontmatter stays relative so spar-score re-joins it.
        expect(md).toContain(`worktree: ${brief.worktree}`);
        expect(parseSparBrief(md)?.worktree).toBe(brief.worktree);
    });
    test("non-brief content -> null", () => {
        expect(parseSparBrief("nope")).toBeNull();
    });
    test("baseline block missing `landed` -> null (no silent landed:undefined)", () => {
        const md = renderSparBrief(brief);
        const { landed, ...rest } = brief.baseline;
        void landed;
        const stripped = md.replace(
            /```json baseline\n[\s\S]*?\n```/,
            "```json baseline\n" + JSON.stringify(rest, null, 2) + "\n```",
        );
        expect(parseSparBrief(stripped)).toBeNull();
    });
});

describe("renderSparReport", () => {
    test("receipt table with baseline|variant|delta + verdict", () => {
        const score = scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.80 }));
        const md = renderSparReport(score, brief);
        expect(md).toContain("# Spar report: ab12cd34-2026-06-13");
        expect(md).toContain("skill: tdd ON");
        expect(md).toContain("cost");
        expect(md).toContain("WIN");
    });
});

describe("parseSparScore", () => {
    test("accepts a complete machine score", () => {
        const score = { ...scoreSpar(brief.baseline, baseMetrics({ costUsd: 0.8 })), id: brief.id, variantSession: "variant" };
        expect(parseSparScore(JSON.stringify(score))).toEqual(score);
    });

    test("rejects a score with an invalid metric", () => {
        const score = { ...scoreSpar(brief.baseline, baseMetrics()), id: brief.id, variantSession: "variant" };
        expect(parseSparScore(JSON.stringify({ ...score, variant: { ...score.variant, turns: "many" } }))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Effect glue (real-decode CacheRead fake - @ax/lib/testing/cache)
// ---------------------------------------------------------------------------

const cacheRead = (routes: TestCacheOptions["routes"]) =>
    makeTestCacheRead(routes !== undefined ? { routes } : {});

const runCache = <A>(
    eff: Effect.Effect<A, CacheReadError, CacheRead>,
    layer: Layer.Layer<CacheRead>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("fetchSessionMetrics", () => {
    test("composes cost + churn + turn/wall for a session", async () => {
        const since = new Date("2026-06-11T00:00:00.000Z");
        // routes: cost usage, churn base scan, churn fan-out, and the focused
        // turn/wall lookup. Unmatched -> [[]] (pricing falls back to built-in).
        const { layer } = cacheRead({
            "FROM session_token_usage": [[
                { session: "session:`s1`", model: "claude", estimated_tokens: 1_000, estimated_cost_usd: 1.5 },
            ]],
            // churn base session scan (selects id AS session, source)
            "AS session, source\nFROM session": [[
                { session: "session:`s1`", source: "codex" },
            ]],
            "FROM produced": [[{ session: "session:`s1`", commit: "commit:`c1`" }]],
            "FROM touched": [[
                { commit: "commit:`c1`", file: "file:`f1`", path: "src/a.ts", additions: 13, deletions: 3 },
            ]],
            // churn edit events: an initial edit (enables episode opening),
            // then the repair edit between the failure and its pass.
            "FROM tool_call": [[
                { session: "session:`s1`", ts: "2026-06-11T00:01:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb" }) },
                { session: "session:`s1`", ts: "2026-06-11T00:03:00.000Z", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) },
            ]],
            // failure opens an episode; the later pass closes it so the
            // edit between them is classified as repair.
            "FROM command_outcome": [[
                { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", kind: "check", status: "error", command_norm: "tsc" },
                { session: "session:`s1`", ts: "2026-06-11T00:04:00.000Z", kind: "check", status: "ok", command_norm: "tsc" },
            ]],
            // focused turn/wall lookup (real DuckDB SELECT against `session`,
            // count(*) subquery against `turn`): row carries turn_count +
            // started_at/ended_at (Date, decoded via TimestampColumn).
            "AS turn_count": [
                { turn_count: 21, started_at: "2026-06-11T00:00:00.000Z", ended_at: "2026-06-11T00:10:00.000Z" },
            ],
        });

        const m = await runCache(fetchSessionMetrics("session:`s1`", since), layer);
        expect(m.costUsd).toBe(1.5);
        expect(m.turns).toBe(21);
        expect(m.wallMs).toBe(600_000);
        expect(m.landed).toBe(true);
        expect(m.repairLines).toBeGreaterThan(0);
        expect(m.episodes).toBeGreaterThan(0);
    });

    test("clean variant: in produced edge but absent from hotSessions -> landed:true, repair:0", async () => {
        // Regression guard: a session that landed cleanly (produced a commit,
        // zero verification failures) is FILTERED OUT of churn.hotSessions by
        // hasVerificationSignal. landed must come from the produced edge, not
        // hotSessions - otherwise the best outcome scores as a regression.
        const { layer } = cacheRead({
            "FROM session_token_usage": [[
                { session: "session:`clean`", model: "claude", estimated_tokens: 500, estimated_cost_usd: 0.7 },
            ]],
            // churn base scan: clean session has NO verification signal, so
            // it never appears here (and thus never in hotSessions).
            "AS session, source\nFROM session": [[]],
            // produced edge + touched LOC DO carry the clean session.
            "FROM produced": [[{ session: "session:`clean`", commit: "commit:`cc`" }]],
            "FROM touched": [[
                { commit: "commit:`cc`", file: "file:`f1`", path: "src/a.ts", additions: 9, deletions: 1 },
            ]],
            "AS turn_count": [
                { turn_count: 12, started_at: "2026-06-11T00:00:00.000Z", ended_at: "2026-06-11T00:05:00.000Z" },
            ],
        });

        const m = await runCache(
            fetchSessionMetrics("session:`clean`", new Date("2026-06-11T00:00:00.000Z")),
            layer,
        );
        expect(m.landed).toBe(true);
        expect(m.repairLines).toBe(0);
        expect(m.episodes).toBe(0);
        expect(m.costUsd).toBe(0.7);
        expect(m.turns).toBe(12);
    });

    test("null cost + null turn/wall when nothing matches", async () => {
        const { layer } = cacheRead({});
        const m = await runCache(
            fetchSessionMetrics("session:`ghost`", new Date("2026-06-11T00:00:00.000Z")),
            layer,
        );
        expect(m.costUsd).toBeNull();
        expect(m.turns).toBeNull();
        expect(m.wallMs).toBeNull();
        expect(m.repairLines).toBe(0);
        expect(m.episodes).toBe(0);
        expect(m.landed).toBe(false);
    });
});

describe("findVariantSession", () => {
    test("returns the most recent bare id; binds cwd + since as parameters", async () => {
        const { layer, captured } = cacheRead({
            "FROM session": [{ id: "variant" }],
        });
        const id = await runCache(
            findVariantSession("/abs/cwd", Date.parse("2026-06-13T10:00:00.000Z")),
            layer,
        );
        expect(id).toBe("variant");
        const sql = captured[0]!;
        // DuckDB binds are positional `?` placeholders, not interpolated
        // literals - the cwd/since values are proven by the fixture's
        // param-inspecting variants below, not by string content here.
        expect(sql).toContain("cwd = ?");
        expect(sql).toContain("started_at >= ?");
        expect(sql).toContain("ORDER BY started_at DESC LIMIT 1");
    });

    test("binds the given cwd and since as positional parameters", async () => {
        let seenParams: readonly unknown[] | undefined;
        const { layer } = cacheRead({
            "FROM session": (_sql, params) => {
                seenParams = params;
                return [{ id: "variant" }];
            },
        });
        const sinceMs = Date.parse("2026-06-13T10:00:00.000Z");
        await runCache(findVariantSession("/abs/cwd", sinceMs), layer);
        expect(seenParams?.[0]).toBe("/abs/cwd");
        expect((seenParams?.[1] as Date).getTime()).toBe(sinceMs);
    });

    test("returns null when no variant session exists", async () => {
        const { layer } = cacheRead({});
        const id = await runCache(
            findVariantSession("/abs/cwd", Date.now()),
            layer,
        );
        expect(id).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// stampSparSession
// ---------------------------------------------------------------------------

describe("stampSparSession", () => {
    test("writes one spar label row to the judgment sidecar", async () => {
        const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
        await Effect.runPromise(stampSparSession("session:abc").pipe(
            Effect.provide(judgmentTestLayer(() => [], () => 0, (table, row) => {
                writes.push({ table, row: { ...row } });
            })),
        ));
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ table: "session_label", row: { session_id: "abc", label: "spar", source: "spar-score" } });
    });
});
