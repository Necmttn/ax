/**
 * Integration test for the Durable Streams backing of the IngestStreamBus.
 *
 * Starts a real in-memory `DurableStreamTestServer` sidecar, publishes two
 * ingest events to one run's stream, then reads them back via the real
 * `@durable-streams/client` catch-up read and asserts both events plus a
 * non-empty resume offset come through.
 *
 * Gated on `AX_STREAM_E2E=1`. Without that env var the suite skips trivially
 * (no server is started). Mirrors the AX_E2E_DB skip idiom used elsewhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stream } from "@durable-streams/client";
import {
    createDurableIngestStream,
    type DurableIngestStream,
} from "./ingest-stream-durable.ts";
import type { IngestStreamEvent } from "../ingest/stream-events.ts";

const E2E_ENABLED = process.env.AX_STREAM_E2E === "1";

describe(
    E2E_ENABLED
        ? "ingest-stream-durable (real sidecar)"
        : "ingest-stream-durable (real sidecar - skipped, set AX_STREAM_E2E=1)",
    () => {
        if (!E2E_ENABLED) {
            test.skip("guard", () => undefined);
            return;
        }

        let bus: DurableIngestStream;

        beforeAll(async () => {
            bus = await createDurableIngestStream();
        });

        afterAll(async () => {
            await bus?.stop();
        });

        test("publishes events to a per-run stream and catch-up reads them back with a resume offset", async () => {
            const runId = `test-${crypto.randomUUID()}`;

            const started: IngestStreamEvent = { kind: "stage_started", runId, stage: "discover" };
            const finished: IngestStreamEvent = {
                kind: "stage_finished",
                runId,
                stage: "discover",
                status: "ok",
                durationMs: 42,
            };

            await bus.publish(runId, started);
            await bus.publish(runId, finished);

            const res = await stream<IngestStreamEvent>({
                url: bus.streamUrl(runId),
                live: false,
            });
            const items = await res.json<IngestStreamEvent>();

            expect(items).toEqual([started, finished]);
            expect(typeof res.offset).toBe("string");
            expect(res.offset.length).toBeGreaterThan(0);
        });
    },
);
