import { describe, expect, test } from "bun:test";
import {
    buildIngestEventStatement,
    buildIngestRunStartStatement,
    makeIngestEvent,
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

    test("buildIngestRunStartStatement writes run record", () => {
        expect(buildIngestRunStartStatement({ runId: "r1", command: "ingest", sinceDays: 1 }))
            .toContain("UPSERT ingest_run:`r1`");
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
        expect(buildIngestEventStatement(event)).toContain('"files":3');
    });
});
