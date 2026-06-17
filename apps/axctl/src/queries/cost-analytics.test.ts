import { describe, expect, test } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import {
    fetchCostModels,
    fetchCostSessions,
    fetchCostSplit,
} from "./cost-analytics.ts";

// ---------------------------------------------------------------------------
// fetchCostModels
// ---------------------------------------------------------------------------

describe("fetchCostModels", () => {
    test("aggregates per-model rows and sorts by cost desc", async () => {
        const dbRows = [
            { model: "claude-opus-4-8", sessions: 10, prompt_tokens: 1000, completion_tokens: 200,
              cache_read_tokens: 50, cache_create_tokens: 20, cost_usd: 5.0 },
            { model: "gpt-5.5", sessions: 5, prompt_tokens: 500, completion_tokens: 100,
              cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 2.0 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostModels({ sinceDays: 14 }));

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]!.model).toBe("claude-opus-4-8");
        expect(result.rows[0]!.cost_usd).toBe(5.0);
        expect(result.rows[1]!.model).toBe("gpt-5.5");
        expect(result.total_cost_usd).toBeCloseTo(7.0);
    });

    test("maps null model to (unattributed)", async () => {
        const dbRows = [
            { model: null, sessions: 3, prompt_tokens: 100, completion_tokens: 50,
              cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostModels({ sinceDays: 14 }));

        expect(result.rows[0]!.model).toBe("(unattributed)");
    });

    test("handles empty result", async () => {
        const db = makeMockDb([[[]]] );
        const result = await runWithMock(db, fetchCostModels({ sinceDays: 14 }));

        expect(result.rows).toHaveLength(0);
        expect(result.total_cost_usd).toBe(0);
    });

    test("SQL includes the since window", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostModels({ sinceDays: 7 }));
        expect(db.captured[0]).toContain("time::now() - 7d");
    });

    test("SQL groups by model and orders by cost_usd", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostModels({ sinceDays: 14 }));
        expect(db.captured[0]).toContain("GROUP BY model");
        expect(db.captured[0]).toContain("ORDER BY cost_usd DESC");
    });
});

// ---------------------------------------------------------------------------
// fetchCostSessions
// ---------------------------------------------------------------------------

describe("fetchCostSessions", () => {
    test("returns sessions sorted by cost desc", async () => {
        const dbRows = [
            {
                session_id: "session:abc123",
                project: "ax",
                model: "claude-opus-4-8",
                started_at: "2026-06-10T00:00:00.000Z",
                cost_usd: 3.5,
                completion_tokens: 1000,
                cache_read_tokens: 500,
            },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: null }));

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]!.session_id).toBe("session:abc123");
        expect(result.rows[0]!.cost_usd).toBe(3.5);
        expect(result.rows[0]!.model).toBe("claude-opus-4-8");
    });

    test("null fields are preserved as null", async () => {
        const dbRows = [
            {
                session_id: "session:x",
                project: null,
                model: null,
                started_at: null,
                cost_usd: 0.5,
                completion_tokens: 0,
                cache_read_tokens: 0,
            },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: null }));

        expect(result.rows[0]!.project).toBeNull();
        expect(result.rows[0]!.model).toBeNull();
        expect(result.rows[0]!.started_at).toBeNull();
    });

    test("SQL includes model filter when provided", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: "claude-opus-4-8" }));
        expect(db.captured[0]).toContain("claude-opus-4-8");
    });

    test("SQL does not include model filter when null", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: null }));
        expect(db.captured[0]).not.toContain("model =");
    });

    test("SQL limits results", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 5, model: null }));
        expect(db.captured[0]).toContain("LIMIT 5");
    });
});

// ---------------------------------------------------------------------------
// fetchCostSplit
// ---------------------------------------------------------------------------

describe("fetchCostSplit", () => {
    test("partitions source=claude-subagent into subagent origin", async () => {
        const dbRows = [
            { source: "claude", model: "claude-opus-4-8", sessions: 5,
              prompt_tokens: 1000, completion_tokens: 200,
              cache_read_tokens: 50, cache_create_tokens: 10, cost_usd: 4.0 },
            { source: "claude-subagent", model: null, sessions: 2,
              prompt_tokens: 300, completion_tokens: 60,
              cache_read_tokens: 10, cache_create_tokens: 5, cost_usd: 1.0 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        const mainRow = result.rows.find((r) => r.origin === "main");
        const subRow = result.rows.find((r) => r.origin === "subagent");

        expect(mainRow).toBeDefined();
        expect(subRow).toBeDefined();
        expect(mainRow!.model).toBe("claude-opus-4-8");
        expect(subRow!.model).toBe("(unattributed)");
    });

    test("computes share_pct relative to total", async () => {
        const dbRows = [
            { source: "claude", model: "A", sessions: 1,
              prompt_tokens: 100, completion_tokens: 10,
              cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 3.0 },
            { source: "codex", model: "B", sessions: 1,
              prompt_tokens: 50, completion_tokens: 5,
              cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        const a = result.rows.find((r) => r.model === "A")!;
        const b = result.rows.find((r) => r.model === "B")!;
        expect(a.share_pct).toBeCloseTo(75);
        expect(b.share_pct).toBeCloseTo(25);
    });

    test("totals aggregate across all rows", async () => {
        const dbRows = [
            { source: "claude", model: "X", sessions: 3,
              prompt_tokens: 100, completion_tokens: 20,
              cache_read_tokens: 5, cache_create_tokens: 2, cost_usd: 2.0 },
            { source: "claude-subagent", model: null, sessions: 7,
              prompt_tokens: 200, completion_tokens: 40,
              cache_read_tokens: 10, cache_create_tokens: 4, cost_usd: 1.5 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        expect(result.totals.sessions).toBe(10);
        expect(result.totals.prompt_tokens).toBe(300);
        expect(result.totals.cost_usd).toBeCloseTo(3.5);
    });

    test("handles zero total cost without NaN share_pct", async () => {
        const dbRows = [
            { source: "claude", model: "X", sessions: 1,
              prompt_tokens: 100, completion_tokens: 10,
              cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 0 },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        expect(result.rows[0]!.share_pct).toBe(0);
    });

    test("SQL groups by source and model", async () => {
        const db = makeMockDb([[[]]] );
        await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));
        expect(db.captured[0]).toContain("GROUP BY source, model");
    });
});

// ---------------------------------------------------------------------------
// NaN-guard regression tests (F-graph-toolkit: finite guard via countField)
// Decision: FIX - NaN propagation in cost/token aggregation silently
// corrupts downstream sums, sorts, and pct calculations. countField's finite
// guard clamps NaN→0. SurrealDB math::sum() shouldn't return NaN in practice
// but the guard is a zero-cost safety net.
// ---------------------------------------------------------------------------

describe("fetchCostModels - NaN-guard (countField adoption)", () => {
    test("NaN token fields clamp to 0, not NaN (finite guard)", async () => {
        // Simulate a row where DB returns NaN for a numeric field (edge case)
        const dbRows = [
            {
                model: "test-model",
                sessions: Number.NaN,
                prompt_tokens: Number.NaN,
                completion_tokens: 0,
                cache_read_tokens: 0,
                cache_create_tokens: 0,
                cost_usd: Number.NaN,
            },
        ];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostModels({ sinceDays: 14 }));

        // countField clamps NaN → 0 (was: Number(NaN ?? 0) = NaN before fix)
        expect(Number.isFinite(result.rows[0]!.sessions)).toBe(true);
        expect(result.rows[0]!.sessions).toBe(0);
        expect(Number.isFinite(result.rows[0]!.cost_usd)).toBe(true);
        expect(result.rows[0]!.cost_usd).toBe(0);
        // total_cost_usd must also be finite (would be NaN if propagation happened)
        expect(Number.isFinite(result.total_cost_usd)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// fetchCostSplit - content-type dimension (global breakdown, ADAPT path)
// CostSplitRow is aggregated by (origin x model) with no per-session id,
// so a per-row dominant content type is meaningless. Instead, the global
// ContentTypeBreakdown is attached as `result.contentTypes`.
// ---------------------------------------------------------------------------

describe("fetchCostSplit - contentTypes dimension", () => {
    test("includes global content-type breakdown as sibling field on result", async () => {
        const splitRows = [
            {
                source: "claude", model: "claude-sonnet-4-6", sessions: 3,
                prompt_tokens: 300, completion_tokens: 60,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.5,
            },
        ];
        // Second query: fetchContentTypeBreakdown returns flat rows
        const contentTypeRows = [
            { ct: "content_type:code", calls: 5, bytes: 400 },
            { ct: "content_type:docs", calls: 2, bytes: 200 },
        ];
        const db = makeMockDb([[splitRows], [contentTypeRows]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        expect(result.contentTypes).toBeDefined();
        // rows are sorted by estTokens desc; code (400 bytes) > docs (200 bytes)
        expect(result.contentTypes.rows).toHaveLength(2);
        expect(result.contentTypes.rows[0]!.category).toBe("code");
        expect(result.contentTypes.rows[1]!.category).toBe("docs");
        expect(result.contentTypes.totals.bytes).toBe(600);
    });

    test("contentTypes is empty breakdown when no content edges exist", async () => {
        const splitRows = [
            {
                source: "claude", model: "A", sessions: 1,
                prompt_tokens: 100, completion_tokens: 10,
                cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0,
            },
        ];
        // Empty content-type response
        const db = makeMockDb([[splitRows], [[]]]);
        const result = await runWithMock(db, fetchCostSplit({ sinceDays: 14 }));

        expect(result.contentTypes.rows).toHaveLength(0);
        expect(result.contentTypes.totals.bytes).toBe(0);
    });
});

describe("fetchCostSessions - stringFieldOr adoption", () => {
    test("session_id from DB string round-trips unchanged", async () => {
        const dbRows = [{
            session_id: "session:abc123",
            project: null, model: null, started_at: null,
            cost_usd: 1.0, completion_tokens: 100, cache_read_tokens: 0,
        }];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: null }));
        expect(result.rows[0]!.session_id).toBe("session:abc123");
    });

    test("missing session_id defaults to empty string (not undefined)", async () => {
        // stringFieldOr default fallback for missing key
        const dbRows = [{
            project: null, model: null, started_at: null,
            cost_usd: 0.5, completion_tokens: 0, cache_read_tokens: 0,
        }];
        const db = makeMockDb([[dbRows]]);
        const result = await runWithMock(db, fetchCostSessions({ sinceDays: 14, limit: 20, model: null }));
        expect(result.rows[0]!.session_id).toBe("");
    });
});
