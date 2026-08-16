import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import {
    FILE_ATTENTION_SQL,
    fetchGraphExplorer,
    normalizeGraphMode,
    resolveGraphExplorerMode,
    rowsToGraphPayload,
    validateFileAttentionSql,
} from "./graph-explorer.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("graph-explorer");

describe("graph explorer", () => {
    test("normalizeGraphMode defaults unknown to file-attention", () => {
        expect(normalizeGraphMode(null)).toBe("file-attention");
        expect(normalizeGraphMode("nope")).toBe("file-attention");
        expect(normalizeGraphMode("delivery")).toBe("delivery");
    });

    test("resolveGraphExplorerMode marks staged modes without falling back", () => {
        expect(resolveGraphExplorerMode("file-attention")).toEqual({
            requestedMode: "file-attention",
            effectiveMode: "file-attention",
            implemented: true,
            warnings: [],
        });
        expect(resolveGraphExplorerMode("delivery")).toEqual({
            requestedMode: "delivery",
            effectiveMode: "delivery",
            implemented: false,
            warnings: ['Mode "delivery" is staged; no graph query is implemented yet.'],
        });
    });

    test("file attention query avoids invalid grouped decoration", () => {
        expect(validateFileAttentionSql()).toEqual([]);
        // 3 lowercase-filter bindings (path / project, matched twice for the
        // OR) + 1 limit binding, all bound `?` params under DuckDB.
        expect((FILE_ATTENTION_SQL.match(/\?/g) ?? []).length).toBeGreaterThanOrEqual(4);
        expect(FILE_ATTENTION_SQL).toContain("MAX(e.ts) AS last_seen");
        expect(FILE_ATTENTION_SQL).toContain("GROUP BY t.session, e.out_id");
        // issue #77: turn-derived metrics are precomputed on session_health;
        // the turn table must be referenced exactly once (the aggregate
        // subquery's JOIN), never scanned again per outer result row.
        expect((FILE_ATTENTION_SQL.match(/\bturn\b/gi) ?? []).length).toBe(1);
        expect(FILE_ATTENTION_SQL).toContain("session_health");
        expect(FILE_ATTENTION_SQL).toContain("task_label");
        expect(FILE_ATTENTION_SQL).not.toContain("GROUP BY in.session");
    });

    test("rowsToGraphPayload builds typed graph with inspector panels", () => {
        const modeResolution = resolveGraphExplorerMode("file-attention");
        const payload = rowsToGraphPayload({
            generatedAt: "2026-05-15T00:00:00.000Z",
            mode: modeResolution.effectiveMode,
            query: "dashboard",
            warnings: modeResolution.warnings,
            rows: [
                {
                    source_id: "session:one",
                    source_label: "Can you make the graph explain what the session was about?",
                    source_kind: "session",
                    source_subtitle: "ax",
                    target_id: "file:dashboard",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    target_subtitle: "ts",
                    relation: "edited",
                    weight: 3,
                    last_seen: "2026-05-14T12:00:00.000Z",
                    source_started_at: "2026-05-14T11:00:00.000Z",
                    source_ended_at: "2026-05-14T11:45:00.000Z",
                    source_user_turns: 4,
                    source_assistant_turns: 9,
                    source_corrections: 1,
                    source_interruptions: 0,
                    source_hands_free_ms: 900_000,
                    source_produced_commits: 2,
                    source_delivery_status: "merged_to_main",
                    source_review_pain: "low",
                    source_pr_size: "small",
                    source_pr_title: "Improve graph explainability",
                },
            ],
        });

        expect(payload.generatedAt).toBe("2026-05-15T00:00:00.000Z");
        expect(payload.mode).toBe("file-attention");
        expect(payload.warnings).toEqual([]);
        expect(payload.query).toBe("dashboard");
        expect(payload.nodes).toContainEqual({
            id: "file:dashboard",
            label: "src/dashboard/server.ts",
            kind: "file",
            weight: 3,
            tone: "accent",
            subtitle: "ts",
        });
        expect(payload.nodes).toContainEqual({
            id: "session:one",
            label: "Can you make the graph explain what the session was about?",
            kind: "session",
            weight: 3,
            tone: "neutral",
            subtitle: "ax",
        });
        expect(payload.edges).toEqual([
            {
                source: "session:one",
                target: "file:dashboard",
                relation: "edited",
                weight: 3,
                tone: "attention",
                label: "edited",
                metrics: {
                    weight: 3,
                    last_seen: "2026-05-14T12:00:00.000Z",
                },
            },
        ]);
        expect(payload.panels[0]).toEqual({
            title: "Graph Summary",
            kind: "summary",
            rows: [
                { label: "Mode", value: "file-attention" },
                { label: "Nodes", value: "2" },
                { label: "Edges", value: "1" },
                { label: "Max edge weight", value: "3" },
            ],
        });
        expect(payload.panels[1]?.kind).toBe("evidence");
        expect(payload.panels[1]?.rows[0]?.detail).toBe(
            "Can you make the graph explain what the session was about? -> src/dashboard/server.ts",
        );
        expect(payload.story_cards[0]).toMatchObject({
            session_id: "session:one",
            title: "Can you make the graph explain what the session was about?",
            project: "ax",
            outcome_status: "shipped",
            delivery_status: "merged_to_main",
            review_pain: "low",
            pr_size: "small",
            pr_title: "Improve graph explainability",
            files_touched: 1,
            top_files: ["src/dashboard/server.ts"],
            produced_commits: 2,
            merged_to_main: true,
            duration_ms: 2_700_000,
            hands_free_ms: 900_000,
            user_turns: 4,
            assistant_turns: 9,
            corrections: 1,
            interruptions: 0,
        });
        expect(payload.story_cards[0]?.why_reason).toContain("main signal");
    });

    test("rowsToGraphPayload can represent a staged mode placeholder", () => {
        const modeResolution = resolveGraphExplorerMode("delivery");
        const payload = rowsToGraphPayload({
            generatedAt: "2026-05-15T00:00:00.000Z",
            mode: modeResolution.effectiveMode,
            query: null,
            warnings: modeResolution.warnings,
            rows: [],
        });

        expect(payload.mode).toBe("delivery");
        expect(payload.nodes).toEqual([]);
        expect(payload.edges).toEqual([]);
        expect(payload.story_cards).toEqual([]);
        expect(payload.warnings).toEqual(['Mode "delivery" is staged; no graph query is implemented yet.']);
        expect(payload.panels[0]?.rows).toContainEqual({ label: "Mode", value: "delivery" });
    });

    test("rowsToGraphPayload dedupes shared source and target nodes", () => {
        const payload = rowsToGraphPayload({
            mode: "file-attention",
            rows: [
                {
                    source_id: "session:one",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:server",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 2,
                },
                {
                    source_id: "session:one",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:graph",
                    target_label: "src/dashboard/graph-explorer.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 4,
                },
                {
                    source_id: "session:two",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:server",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 1,
                },
            ],
        });

        expect(payload.nodes).toHaveLength(4);
        expect(payload.edges).toHaveLength(3);
        expect(payload.nodes.find((node) => node.id === "session:one")?.weight).toBe(6);
        expect(payload.nodes.find((node) => node.id === "file:server")?.weight).toBe(3);
        expect(payload.story_cards.find((story) => story.session_id === "session:one")).toMatchObject({
            files_touched: 2,
            top_files: ["src/dashboard/graph-explorer.ts", "src/dashboard/server.ts"],
        });
    });
});

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "s1", project: "ax", cwd: "/repo", started_at: new Date("2026-01-01T00:00:00Z"), ended_at: new Date("2026-01-01T01:00:00Z") },
        ]);
        yield* w.putMany("session_health", [
            { id: "sh1", session: "s1", source: "claude", task_label: "fix the parser", user_turns: 5, assistant_turns: 6, correction_turns: 1, interruptions: 0 },
        ]);
        yield* w.putMany("file", [
            { id: "f1", path: "src/dashboard/graph-explorer.ts", lang: "typescript" },
            { id: "f2", path: "src/dashboard/other.ts", lang: "typescript" },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "s1", seq: 1, ts: new Date("2026-01-01T00:00:30Z"), role: "assistant" },
        ]);
        yield* w.putMany("edited", [
            { id: "e1", in_id: "t1", out_id: "f1", tool: "Edit", ts: new Date("2026-01-01T00:00:30Z") },
            { id: "e2", in_id: "t1", out_id: "f1", tool: "Edit", ts: new Date("2026-01-01T00:00:45Z") },
            { id: "e3", in_id: "t1", out_id: "f2", tool: "Edit", ts: new Date("2026-01-01T00:00:50Z") },
        ]);
        yield* w.putMany("produced", [
            { id: "p1", in_id: "s1", out_id: "c1", ts: new Date("2026-01-01T00:30:00Z") },
        ]);
        yield* w.putMany("delivery_outcome", [
            { id: "d1", session: "s1", status: "merged_to_main", review_pain: "low", pr_size: "small" },
        ]);
    });

describe("fetchGraphExplorer (real DuckDB fixture)", () => {
    dtest("file-attention mode joins edited/session/session_health/delivery_outcome into a graph payload", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-graph-explorer-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchGraphExplorer({ mode: "file-attention", limit: 50 }));

        expect(payload.mode).toBe("file-attention");
        const sessionNode = payload.nodes.find((n) => n.id === "s1");
        expect(sessionNode?.label).toBe("fix the parser"); // from session_health.task_label
        const fileEdge = payload.edges.find((e) => e.source === "s1" && e.target === "f1");
        expect(fileEdge?.weight).toBe(2); // two edits of f1

        const story = payload.story_cards.find((s) => s.session_id === "s1");
        expect(story?.produced_commits).toBe(1);
        expect(story?.merged_to_main).toBe(true);
        expect(story?.files_touched).toBe(2);
    });

    dtest("q filters by lowercased file path substring", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-graph-explorer-q-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchGraphExplorer({ mode: "file-attention", q: "other", limit: 50 }));

        expect(payload.edges.every((e) => e.target === "f2")).toBe(true);
        expect(payload.edges.length).toBeGreaterThan(0);
    });

    dtest("an unimplemented mode returns an empty payload with a staged warning, no query fires", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-graph-explorer-staged-"), dylibPath, () => Effect.void));
        const payload = await readThroughFixture(fixture, dylibPath, fetchGraphExplorer({ mode: "delivery" }));

        expect(payload.mode).toBe("delivery");
        expect(payload.nodes).toEqual([]);
        expect(payload.warnings.length).toBeGreaterThan(0);
    });
});
