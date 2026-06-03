import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    type ClaudeInsightReadResult,
    facetToInsightAndFriction,
    readClaudeInsightConversions,
} from "./claude-insights.ts";

// Real Bun-backed FileSystem + Path against the tmp-dir fixtures (no mock):
// readClaudeInsightConversions now requires FileSystem + Path after the
// @effect/platform migration.
const FsLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const runFs = <A, E>(
    eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(FsLayer)));

describe("Claude insights conversion", () => {
    test("converts a facet into one insight and counted friction events", () => {
        const converted = facetToInsightAndFriction({
            sourcePath: "/tmp/usage-data/facets/session-1.json",
            facet: {
                session_id: "session-1",
                underlying_goal: "Ship the work",
                goal_categories: { implementation: 1 },
                outcome: "completed",
                user_satisfaction_counts: { positive: 1 },
                claude_helpfulness: "very_helpful",
                session_type: "implementation",
                friction_counts: {
                    wrong_approach: 1,
                    output_token_limit_exceeded: 2,
                },
                friction_detail: "Claude hit token limits after taking the wrong approach.",
                primary_success: "merged_change",
                brief_summary: "Claude completed the implementation after a redirect.",
            },
        });

        expect(converted.insight).toMatchObject({
            key: "session-1__claude_insights",
            subjectType: "session",
            subjectId: "session-1",
            kind: "claude_insights",
            text: "Claude completed the implementation after a redirect.",
            labels: {
                source: "claude_insights",
                source_path: "/tmp/usage-data/facets/session-1.json",
                outcome: "completed",
                goal_categories: { implementation: 1 },
                session_type: "implementation",
                helpfulness: "very_helpful",
                user_satisfaction_counts: { positive: 1 },
                primary_success: "merged_change",
            },
            metrics: {
                friction_counts: {
                    wrong_approach: 1,
                    output_token_limit_exceeded: 2,
                },
            },
        });

        expect(converted.frictionEvents).toHaveLength(3);
        expect(converted.frictionEvents.map((event) => event.kind)).toEqual([
            "wrong_approach",
            "runtime_limit",
            "runtime_limit",
        ]);
        expect(converted.frictionEvents.map((event) => event.key)).toEqual([
            "session-1__claude_insights__wrong_approach__wrong_approach__1",
            "session-1__claude_insights__runtime_limit__output_token_limit_exceeded__1",
            "session-1__claude_insights__runtime_limit__output_token_limit_exceeded__2",
        ]);
        expect(converted.frictionEvents[1]).toMatchObject({
            sessionId: "session-1",
            text: "Claude hit token limits after taking the wrong approach.",
            labels: {
                source: "claude_insights",
                raw_kind: "output_token_limit_exceeded",
                normalized_kind: "runtime_limit",
            },
            raw: {
                raw_kind: "output_token_limit_exceeded",
                normalized_kind: "runtime_limit",
                ordinal: 1,
                count: 2,
            },
        });
    });

    test("falls back to underlying goal when brief_summary is absent", () => {
        const converted = facetToInsightAndFriction({
            sourcePath: "/tmp/usage-data/facets/session-2.json",
            facet: {
                session_id: "session-2",
                underlying_goal: "Review CI failures and identify the blocker",
                friction_counts: {},
                friction_detail: "",
            },
        });

        expect(converted.insight.text).toBe(
            "Review CI failures and identify the blocker",
        );
        expect(converted.frictionEvents).toEqual([]);
    });

    test("adds session-meta numeric metrics without putting operational fields on labels", () => {
        const converted = facetToInsightAndFriction({
            sourcePath: "/tmp/usage-data/facets/session-3.json",
            facet: {
                session_id: "session-3",
                brief_summary: "Claude explored the issue.",
                friction_counts: {
                    environment_issue: 1,
                },
            },
            meta: {
                session_id: "session-3",
                project_path: "/Users/necmttn/Projects/ax",
                start_time: "2026-05-04T01:19:27.501Z",
                duration_minutes: 2,
                user_message_count: 4,
                assistant_message_count: 41,
                tool_counts: { Bash: 2, Read: 1 },
                languages: { TypeScript: 1 },
                git_commits: 0,
                input_tokens: 63,
                output_tokens: 2325,
                tool_errors: 0,
                tool_error_categories: {},
                uses_mcp: true,
            },
        });

        expect(converted.insight.labels).toMatchObject({
            project_path: "/Users/necmttn/Projects/ax",
        });
        expect(converted.insight.metrics).toMatchObject({
            friction_counts: {
                environment_issue: 1,
            },
            duration_minutes: 2,
            user_message_count: 4,
            assistant_message_count: 41,
            tool_counts: { Bash: 2, Read: 1 },
            languages: { TypeScript: 1 },
            git_commits: 0,
            input_tokens: 63,
            output_tokens: 2325,
            tool_errors: 0,
        });
        expect(converted.frictionEvents[0]).toMatchObject({
            kind: "environment_blocker",
            ts: "2026-05-04T01:19:27.501Z",
        });
    });

    test("reads facets with matching session-meta and skips malformed JSON", async () => {
        const root = await mkdtemp(join(tmpdir(), "ax-insights-"));
        try {
            await mkdir(join(root, "facets"));
            await mkdir(join(root, "session-meta"));
            await writeFile(
                join(root, "facets", "session-4.json"),
                JSON.stringify({
                    session_id: "session-4",
                    brief_summary: "Claude completed a focused task.",
                    friction_counts: {},
                }),
            );
            await writeFile(join(root, "facets", "bad.json"), "{not-json");
            await writeFile(
                join(root, "session-meta", "session-4.json"),
                JSON.stringify({
                    session_id: "session-4",
                    duration_minutes: 3,
                    output_tokens: 1000,
                }),
            );

            const warn = console.warn;
            let result: ClaudeInsightReadResult | null = null;
            try {
                console.warn = () => {};
                result = await runFs(readClaudeInsightConversions(root));
            } finally {
                console.warn = warn;
            }

            expect(result).not.toBeNull();
            if (!result) return;
            expect(result.stats).toEqual({
                facets: 1,
                sessionMeta: 1,
                malformed: 1,
            });
            expect(result.items).toHaveLength(1);
            expect(result.items[0]?.conversion.insight.metrics).toMatchObject({
                duration_minutes: 3,
                output_tokens: 1000,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
