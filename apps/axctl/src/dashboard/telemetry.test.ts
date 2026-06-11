import { describe, expect, test } from "bun:test";
import {
    addIngestEventSubscriber,
    buildIngestEventStatement,
    buildIngestStageFinishStatement,
    buildIngestStageStartStatement,
    buildIngestRunFinishStatement,
    buildIngestRunStartStatement,
    makeIngestEvent,
    publishIngestEvent,
    removeIngestEventSubscriber,
} from "./telemetry.ts";

describe("dashboard telemetry", () => {
    test("makeIngestEvent creates stable event shape", () => {
        const event = makeIngestEvent({
            runId: "run1",
            source: "git",
            stage: "write",
            level: "info",
            message: "wrote commits",
            counts: { commits: 2 },
        });
        expect(event.type).toBe("ingest_event");
        expect(event.source).toBe("git");
        expect(event.counts).toEqual({ commits: 2 });
    });

    test("buildIngestRunStartStatement writes run record with an initial heartbeat", () => {
        const sql = buildIngestRunStartStatement({ runId: "r1", command: "ingest", sinceDays: 1 });
        expect(sql).toContain("UPSERT ingest_run:`r1`");
        expect(sql).toContain("last_progress_at: time::now()");
    });

    test("buildIngestRunFinishStatement supports the partial status (timeout/interrupt)", () => {
        const sql = buildIngestRunFinishStatement({
            runId: "r1",
            status: "partial",
            metrics: { error: "timeout after 900s" },
        });
        expect(sql).toContain("UPDATE ingest_run:`r1`");
        expect(sql).toContain('status = "partial"');
        expect(sql).toContain("timeout after 900s");
    });

    test("stage start/finish statements bump the run heartbeat", () => {
        expect(buildIngestStageStartStatement({ runId: "r1", source: "git", stage: "fetch" }))
            .toContain("UPDATE ingest_run:`r1` SET last_progress_at = time::now()");
        expect(buildIngestStageFinishStatement({
            runId: "r1",
            source: "git",
            stage: "fetch",
            status: "ok",
            counts: {},
        })).toContain("UPDATE ingest_run:`r1` SET last_progress_at = time::now()");
    });

    test("buildIngestEventStatement stores JSON counts", () => {
        const event = makeIngestEvent({
            runId: "run1",
            source: "git",
            stage: "write",
            level: "info",
            message: "ok",
            counts: { files: 3 },
        });
        // counts is embedded as a SurrealQL string literal via the shared
        // `surql` seam, which JSON-quotes (double quotes, escaped).
        expect(buildIngestEventStatement(event)).toContain('{\\"files\\":3}');
    });

    test("stage statements use deterministic stage ids", () => {
        expect(buildIngestStageStartStatement({ runId: "r1", source: "git", stage: "fetch" }))
            .toContain("UPSERT ingest_stage:`r1__git__fetch`");
        expect(buildIngestStageFinishStatement({
            runId: "r1",
            source: "git",
            stage: "fetch",
            status: "ok",
            counts: { commits: 2 },
        })).toContain('counts = "{\\"commits\\":2}"');
    });

    test("publishIngestEvent fans out to subscribers", () => {
        const received: unknown[] = [];
        const subscriber = (event: unknown) => {
            received.push(event);
        };
        addIngestEventSubscriber(subscriber);
        const event = makeIngestEvent({
            runId: "run1",
            source: "git",
            stage: "write",
            level: "info",
            message: "ok",
            counts: {},
        });
        publishIngestEvent(event);
        removeIngestEventSubscriber(subscriber);
        expect(received).toEqual([event]);
    });
});
