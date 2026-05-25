import { describe, expect, test } from "bun:test";
import {
    buildLegacySelfImproveStatements,
    readLegacySelfImproveRuns,
    type LegacySelfImproveRunShape,
} from "./legacy-self-improve.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fixtureRun = (): LegacySelfImproveRunShape => ({
    runId: "2026-05-05",
    path: "/tmp/self-improve/runs/2026-05-05",
    events: [{
        id: "retry-1",
        sessionId: "session-1",
        projectSlug: "-Users-necmttn-Projects-ax",
        turnIndex: 42,
        timestamp: "2026-05-05T00:00:00.000Z",
        type: "retry",
        snippet: "retry of Bash",
        trigger: "toolu_123",
        clusterId: "tool_retries",
        raw: { id: "retry-1", type: "retry" },
    }],
    clusters: [{
        id: "tool_retries",
        name: "tool_retries",
        count: 1,
        eventIds: ["retry-1"],
    }],
    proposalPath: "/tmp/self-improve/runs/2026-05-05/proposed-claudemd.md",
    proposalText: "# Proposed guidance\n\nRun focused verification.",
    spendSamples: [0.1, 0.2, 0.3],
    malformedEvents: 0,
});

describe("legacy self-improve ingest", () => {
    test("builds run, artifact, insight, friction, and provenance statements", () => {
        const { statements, stats } = buildLegacySelfImproveStatements(fixtureRun());
        const sql = statements.join("\n");

        expect(stats).toMatchObject({
            events: 1,
            clusters: 1,
            artifacts: 4,
            insights: 3,
            frictionEvents: 1,
            malformedEvents: 0,
        });
        expect(sql).toContain("UPSERT self_improve_run:");
        expect(sql).toContain("UPSERT artifact:");
        expect(sql).toContain("legacy_self_improve_events");
        expect(sql).toContain("UPSERT friction_event:");
        expect(sql).toContain('"tool_retry"');
        expect(sql).toContain("UPSERT insight:");
        expect(sql).toContain("legacy_self_improve_cluster");
        expect(sql).toContain("->has_artifact:");
        expect(sql).toContain("->derived_from:");
    });

    test("reads run directories and tolerates malformed event lines", async () => {
        const root = join(tmpdir(), `ax-legacy-self-improve-${Date.now()}-${Math.random()}`);
        const runDir = join(root, "runs", "2026-05-05");
        await mkdir(runDir, { recursive: true });
        await writeFile(
            join(runDir, "events.jsonl"),
            [
                JSON.stringify({
                    id: "a",
                    session_id: "s",
                    turn_index: 1,
                    timestamp: "2026-05-05T00:00:00Z",
                    type: "user_correction",
                    snippet: "no, do x",
                }),
                "{malformed",
            ].join("\n"),
        );
        await writeFile(
            join(runDir, "clusters.json"),
            JSON.stringify({ corrections: { name: "corrections", event_ids: ["a"], count: 1 } }),
        );
        await writeFile(join(runDir, "proposed-claudemd.md"), "Guidance text");
        await writeFile(join(runDir, "_spend.log"), "0.1\n0.2\n");

        const runs = await readLegacySelfImproveRuns(root);

        expect(runs).toHaveLength(1);
        expect(runs[0].runId).toBe("2026-05-05");
        expect(runs[0].events).toHaveLength(1);
        expect(runs[0].malformedEvents).toBe(1);
        expect(runs[0].clusters[0].id).toBe("corrections");
        expect(runs[0].spendSamples).toEqual([0.1, 0.2]);
    });
});
