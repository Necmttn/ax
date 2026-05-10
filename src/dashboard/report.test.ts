import { describe, expect, test } from "bun:test";
import type { DashboardData } from "./report.ts";
import { renderDashboardHtml } from "./report.ts";

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
    repositories: [
        {
            id: "repository:agentctl",
            name: "agentctl",
            remote_url: "git@github.com:Necmttn/agentctl.git",
            root_path: "/Users/necmttn/Projects/agentctl/.worktrees/evidence-graph-prototype",
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
            project: "agentctl",
            tool_call_count: 42,
            tool_failure_count: 3,
            plan_snapshot_count: 2,
        },
    ],
};

describe("dashboard report renderer", () => {
    test("renders evidence counts and query sections", () => {
        const html = renderDashboardHtml(sampleData);

        expect(html).toContain("agentctl Evidence Dashboard");
        expect(html).toContain("8,870");
        expect(html).toContain("Repository Coverage");
        expect(html).toContain("Schema Coverage");
        expect(html).toContain("Failure Hotspots");
        expect(html).toContain("Recent Friction");
        expect(html).toContain("Active Sessions");
        expect(html).toContain("feature/evidence-graph-prototype");
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
            repositories: [],
            friction: [],
            tools: [],
            sessions: [],
        });

        expect(html).toContain("No repository evidence ingested yet.");
        expect(html).toContain("No failing tool calls found.");
        expect(html).toContain("No friction events found.");
        expect(html).toContain("No session evidence ingested yet.");
    });
});
