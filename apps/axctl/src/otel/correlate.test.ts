import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { sessionRowId } from "@ax/lib/stable-id";
import { bareUuid, correlateOrphanOtel } from "./correlate.ts";

const UUID = "019fbf3f-9241-40c3-b699-e1f62e7c5341";
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("OTLP correlate", { requireFts: true });

describe("session row id and OTLP correlation", () => {
    test("recovers top-level UUIDs and rejects subagent ids", () => {
        expect(bareUuid(sessionRowId("claude", UUID))).toBe(UUID);
        expect(bareUuid(sessionRowId("codex", UUID))).toBe(UUID);
        expect(bareUuid(sessionRowId("claude", "claude-subagent-af3f3b45c70ccf85c"))).toBeNull();
    });

    dtest("writes one session-grain edge across telemetry tables", async () => {
        let rows: ReadonlyArray<Record<string, unknown>> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-correlate-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const now = new Date();
                yield* write.put("session", { id: UUID, source: "claude", started_at: now });
                yield* write.put("otel_metric_point", {
                    id: "metric-1", harness: "claude", metric: "cost", value: 1,
                    session_id: UUID, observed_at: now,
                });
                yield* write.put("otel_log_event", {
                    id: "log-1", harness: "claude", event_name: "usage",
                    session_id: UUID, observed_at: now,
                });
                yield* correlateOrphanOtel(write);
                rows = yield* write.rows(
                    Schema.Struct({ in_id: Schema.String, out_id: Schema.String, out_table: Schema.String }),
                    "SELECT in_id, out_id, out_table FROM telemetry_of",
                );
                yield* correlateOrphanOtel(write);
            }),
        ));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ in_id: UUID, out_id: "metric-1", out_table: "otel_metric_point" });
    });
});
