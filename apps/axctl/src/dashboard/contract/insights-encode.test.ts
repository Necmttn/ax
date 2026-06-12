import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
    EpisodeTimelinePayload,
    SkillGraphPayload,
    ToolFailureDetailPayload,
    ToolFailuresResponse,
    WorkflowResponse,
} from "@ax/lib/shared/api-contract";

/**
 * Encode regression for the insights-extra payloads. Same contract as
 * recall/skills: these are Schema.Struct so the handlers' plain JS-mapped
 * objects encode (a Schema.Class would 400). Synthetic full-shape values
 * pin the field sets - CI has no DB, so these are the only encode guard.
 */
const roundtrip = (schema: Schema.Top, value: unknown): Promise<unknown> =>
    Effect.runPromise(
        Schema.encodeUnknownEffect(Schema.toCodecJson(schema as never))(value) as Effect.Effect<unknown>,
    );

describe("insights-extra payload encode", () => {
    test("ToolFailuresResponse + detail", async () => {
        await roundtrip(ToolFailuresResponse, {
            generatedAt: "t", failures: [{
                label: "Bash", failure_count: 3, last_seen: null, last_error_text: null,
                last_project: null, distinct_sessions: 2, total_calls: 10, failure_rate: 0.3,
                exit_codes: [1, 2], recommendation: "fix", recommendation_reason: "high rate",
            }],
        });
        await roundtrip(ToolFailureDetailPayload, {
            label: "Bash", samples: [{
                ts: "t", exit_code: 1, error_text: null, output_excerpt: null,
                command_text: null, project: null, session_id: null, cwd: null,
            }],
        });
        expect(true).toBe(true);
    });

    test("SkillGraphPayload", async () => {
        const back = await roundtrip(SkillGraphPayload, {
            min_count: 1, limit: 50, node_count: 1, edge_count: 1, max_edge_count: 1,
            nodes: [{ name: "tdd", weight: 3, last_seen: null }],
            edges: [{ source: "tdd", target: "debugging", count: 2, last_seen: null }],
        }) as { edges: Array<{ count: number }> };
        expect(back.edges[0]?.count).toBe(2);
    });

    test("EpisodeTimelinePayload with a node", async () => {
        const back = await roundtrip(EpisodeTimelinePayload, {
            parent_session_id: "s1", project: null, started_at: null, ended_at: null,
            duration_ms: null, node_count: 1, shape: "P→E",
            nodes: [{
                session_id: "s2", role: "child", project: null, source: null,
                started_at: null, ended_at: null, duration_ms: null, phase: "plan",
                top_skills: [{ skill: "tdd", count: 1 }], invocation_count: 1,
            }],
        }) as { nodes: Array<{ phase: string }> };
        expect(back.nodes[0]?.phase).toBe("plan");
    });

    test("WorkflowResponse (deepest nesting)", async () => {
        const back = await roundtrip(WorkflowResponse, {
            generatedAt: "t", weeksLookback: 8, topK: 5,
            skills: [{ week: "2026-W19", counts: [{ label: "tdd", count: 3 }] }],
            tools: [], sessionShape: [{ week: "2026-W19", session_count: 4 }],
            convergence: [{ week: "2026-W19", jaccard: null, topK: ["tdd"], newcomers: [], dropouts: [] }],
            shapes: [{ shape: "P→E", phases: ["plan", "execute"], session_count: 2, example_session_ids: ["s1"] }],
            shapesTotal: 2,
            episodes: [{ parent_session_id: "s1", project: null, started_at: null, child_count: 3, distinct_nicknames: 2 }],
            episode_shapes: [{ shape: "P→E", phases: ["plan"], episode_count: 1, example_parent_ids: ["s1"], avg_children: 3 }],
            episode_shapes_total: 1, narrative: "converging",
        }) as { shapes: Array<{ shape: string }> };
        expect(back.shapes[0]?.shape).toBe("P→E");
    });
});
