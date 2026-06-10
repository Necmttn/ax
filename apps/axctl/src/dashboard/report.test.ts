import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import type { DashboardData } from "./report.ts";
import { renderDashboardHtml, writeDashboard } from "./report.ts";

/** Mock SurrealClient that returns empty result sets for every query, so
 *  `fetchDashboardData` produces a zeroed-out DashboardData without a real DB. */
function makeEmptyDb() {
    return makeTestSurrealClient({ denyWrites: true }).layer;
}

const sampleData: DashboardData = {
    generatedAt: "2026-05-10T00:00:00.000Z",
    counts: {
        toolCalls: 8870,
        planSnapshots: 100,
        insights: 131,
        frictionEvents: 621,
        diagnosticEvents: 451,
        repositories: 27,
        checkouts: 31,
        sessions: 118,
    },
    tableCounts: [
        {
            table: "tool_call",
            count: 8870,
            stage: "active",
            note: "Claude and Codex tool calls with errors and command fields.",
        },
        {
            table: "file_memory",
            count: 0,
            stage: "staged",
            note: "Reserved for per-file tribal knowledge and BM25 search.",
        },
    ],
    git: [
        {
            name: "ax",
            remote_url: "git@github.com:Necmttn/ax.git",
            session_count: 12,
            checkout_linked_session_count: 12,
            produced_count: 4,
            commit_count: 9,
            touched_count: 33,
        },
    ],
    checkoutActivity: [
        {
            repository_name: "ax",
            path: "/Users/necmttn/Projects/ax/.worktrees/evidence-graph-prototype",
            branch: "feature/evidence-graph-prototype",
            worktree_name: "evidence-graph-prototype",
            session_count: 12,
            turn_count: 244,
            tool_call_count: 60,
            tool_failure_count: 3,
            produced_count: 4,
            touched_count: 33,
        },
    ],
    repositories: [
        {
            id: "repository:ax",
            name: "ax",
            remote_url: "git@github.com:Necmttn/ax.git",
            root_path: "/Users/necmttn/Projects/ax/.worktrees/evidence-graph-prototype",
            checkout_count: 2,
            checkout_branches: ["feature/evidence-graph-prototype"],
            default_branch: "main",
        },
    ],
    friction: [
        {
            kind: "tool_failure",
            ts: "2026-05-10T00:01:00.000Z",
            text: "<script>alert('x')</script>",
            labels: JSON.stringify({ project_path: "/tmp/project" }),
        },
    ],
    tools: [
        {
            name: "exec_command",
            command_norm: "bun test",
            exit_code: 1,
            failure_count: 7,
            last_seen: "2026-05-10T00:02:00.000Z",
        },
    ],
    sessions: [
        {
            id: "session:codex-1",
            project: "ax",
            tool_call_count: 42,
            tool_failure_count: 3,
            plan_snapshot_count: 2,
        },
    ],
};

describe("dashboard report renderer", () => {
    test("renders evidence counts and query sections", () => {
        const html = renderDashboardHtml(sampleData);

        expect(html).toContain("axctl Evidence Dashboard");
        expect(html).toContain("8,870");
        expect(html).toContain("Repository Coverage");
        expect(html).toContain("Schema Coverage");
        expect(html).toContain("Git Correlation");
        expect(html).toContain("Checkout Activity");
        expect(html).toContain("Failure Hotspots");
        expect(html).toContain("Recent Friction");
        expect(html).toContain("Active Sessions");
        expect(html).toContain("feature/evidence-graph-prototype");
        expect(html).toContain("evidence-graph-prototype");
        expect(html).toContain("file_memory");
        expect(html).toContain("staged");
    });

    test("escapes transcript-derived content", () => {
        const html = renderDashboardHtml(sampleData);

        expect(html).not.toContain("<script>alert");
        expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    });

    test("keeps empty dashboard useful", () => {
        const html = renderDashboardHtml({
            ...sampleData,
            git: [],
            checkoutActivity: [],
            repositories: [],
            friction: [],
            tools: [],
            sessions: [],
        });

        expect(html).toContain("No repository evidence ingested yet.");
        expect(html).toContain("No git correlation evidence ingested yet.");
        expect(html).toContain("No checkout activity evidence ingested yet.");
        expect(html).toContain("No failing tool calls found.");
        expect(html).toContain("No friction events found.");
        expect(html).toContain("No session evidence ingested yet.");
    });
});

describe("writeDashboard (@effect/platform write path)", () => {
    test("creates the parent dir and writes the rendered HTML to disk", async () => {
        const program = Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const dir = yield* fs.makeTempDirectory({ prefix: "ax-report-test-" });
            // Write into a NESTED, not-yet-existing dir to exercise makeDirectory.
            const outPath = `${dir}/nested/dashboard.html`;
            const result = yield* writeDashboard({ out: outPath, limit: 5 });
            const onDisk = yield* fs.readFileString(result.path);
            return { result, onDisk };
        }).pipe(
            Effect.provide(
                Layer.mergeAll(makeEmptyDb(), BunFileSystem.layer, BunPath.layer),
            ),
        );

        const { result, onDisk } = await Effect.runPromise(program);
        expect(result.path.endsWith("/nested/dashboard.html")).toBe(true);
        expect(result.url.startsWith("file://")).toBe(true);
        expect(onDisk).toContain("axctl Evidence Dashboard");
        expect(onDisk).toBe(renderDashboardHtml(result.data));
    });
});
