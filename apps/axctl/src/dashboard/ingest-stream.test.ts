import { describe, expect, test } from "bun:test";
import { InMemoryIngestStreamBus } from "./ingest-stream.ts";

describe("IngestStreamBus", () => {
    test("publishes events to the per-run stream and replays history", async () => {
        const bus = new InMemoryIngestStreamBus();
        await bus.publish("run1", { kind: "stage_started", runId: "run1", stage: "skills" });
        await bus.publish("run1", { kind: "stage_finished", runId: "run1", stage: "skills", status: "ok", durationMs: 5 });
        expect(bus.history("run1")).toHaveLength(2);
        expect(bus.history("run1")[0]).toMatchObject({ kind: "stage_started", stage: "skills" });
    });
});
