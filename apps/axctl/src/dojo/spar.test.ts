import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { SurrealClient } from "@ax/lib/db";
import { AxConfig, AxConfigTest } from "@ax/lib/config";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import {
    fetchSessionMetrics,
    findVariantSession,
    parseSparBrief,
    renderSparBrief,
    renderSparReport,
    scoreSpar,
} from "./spar.ts";
import type { SparBrief, SparMetrics } from "./spar.ts";

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
    });
    test("non-brief content -> null", () => {
        expect(parseSparBrief("nope")).toBeNull();
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

// ---------------------------------------------------------------------------
// Effect glue (fake SurrealClient)
// ---------------------------------------------------------------------------

// enrichSessions/churn read fan-out width from AxConfig.knobs.
const configLayer = AxConfigTest({}).pipe(Layer.provide(BunFileSystem.layer));

const runDb = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient | AxConfig>,
    layer: Layer.Layer<SurrealClient>,
): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(Layer.mergeAll(layer, configLayer))));

const runDbOnly = <A>(
    eff: Effect.Effect<A, unknown, SurrealClient>,
    layer: Layer.Layer<SurrealClient>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("fetchSessionMetrics", () => {
    test("composes cost + churn + turn/wall for a session", async () => {
        const since = new Date("2026-06-11T00:00:00.000Z");
        // routes: cost usage, churn base scan, churn fan-out, and the focused
        // turn/wall lookup. Unmatched -> [[]] (pricing falls back to built-in).
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: {
                "FROM session_token_usage": [[
                    { session: "session:`s1`", model: "claude", estimated_cost_usd: 1.5 },
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
                    { session: "session:`s1`", ts: "2026-06-11T00:02:00.000Z", status: "error", command_norm: "tsc" },
                    { session: "session:`s1`", ts: "2026-06-11T00:04:00.000Z", status: "ok", command_norm: "tsc" },
                ]],
                // focused turn/wall lookup
                "AS turn_count": [[
                    { turn_count: 21, s: "2026-06-11T00:00:00.000Z", e: "2026-06-11T00:10:00.000Z" },
                ]],
            },
        });

        const m = await runDb(fetchSessionMetrics("session:`s1`", since), tc.layer);
        expect(m.costUsd).toBe(1.5);
        expect(m.turns).toBe(21);
        expect(m.wallMs).toBe(600_000);
        expect(m.landed).toBe(true);
        expect(m.repairLines).toBeGreaterThan(0);
        expect(m.episodes).toBeGreaterThan(0);
    });

    test("null cost + null turn/wall when nothing matches", async () => {
        const tc = makeTestSurrealClient({ denyWrites: true });
        const m = await runDb(
            fetchSessionMetrics("session:`ghost`", new Date("2026-06-11T00:00:00.000Z")),
            tc.layer,
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
    test("returns the most recent bare id; embeds cwd + since literals", async () => {
        const tc = makeTestSurrealClient({
            denyWrites: true,
            routes: { "FROM session": [[{ id: "session:variant" }]] },
        });
        const id = await runDbOnly(
            findVariantSession("/abs/cwd", Date.parse("2026-06-13T10:00:00.000Z")),
            tc.layer,
        );
        expect(id).toBe("session:variant");
        const sql = tc.captured[0]!;
        expect(sql).toContain(`cwd = "/abs/cwd"`);
        expect(sql).toContain("started_at >=");
        expect(sql).toContain("ORDER BY started_at DESC LIMIT 1");
    });

    test("returns null when no variant session exists", async () => {
        const tc = makeTestSurrealClient({ denyWrites: true });
        const id = await runDbOnly(
            findVariantSession("/abs/cwd", Date.now()),
            tc.layer,
        );
        expect(id).toBeNull();
    });
});
