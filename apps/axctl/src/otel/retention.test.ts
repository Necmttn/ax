import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { retainRecentOtel } from "./retention.ts";

describe("retainRecentOtel", () => {
    test("deletes rows via the non-quadratic result-set DELETE form", async () => {
        const db = makeTestSurrealClient();

        await Effect.runPromise(retainRecentOtel().pipe(Effect.provide(db.layer)));

        const sql = db.captured.join("\n");
        for (const table of ["otel_metric_point", "otel_span", "otel_log_event"]) {
            // Correct form: DELETE targets the subquery RESULT by primary id.
            expect(sql).toContain(
                `DELETE (SELECT VALUE id FROM ${table} WHERE observed_at < time::now() - 30d);`,
            );
            // Never the quadratic id-IN-subquery form (measured: never
            // completes at ~460k rows - see provider-events.ts doc comment).
            expect(sql).not.toContain(
                `DELETE ${table} WHERE id IN (SELECT VALUE id FROM ${table}`,
            );
        }
    });

    test("prunes dangling telemetry_of edges left by the otel delete", async () => {
        const db = makeTestSurrealClient();

        await Effect.runPromise(retainRecentOtel().pipe(Effect.provide(db.layer)));

        const sql = db.captured.join("\n");
        expect(sql).toContain(
            "DELETE (SELECT VALUE id FROM telemetry_of WHERE out.id IS NONE);",
        );
        // Same non-quadratic form for the edge cleanup too.
        expect(sql).not.toContain("DELETE telemetry_of WHERE id IN (SELECT");
    });

    test("reports pruned counts for observability", async () => {
        const db = makeTestSurrealClient({
            routes: {
                "SELECT count() FROM otel_log_event": [[{ count: 5 }]],
                "SELECT count() FROM otel_span": [[{ count: 3 }]],
                "SELECT count() FROM otel_metric_point": [[{ count: 1 }]],
                "SELECT count() FROM telemetry_of": [[{ count: 2 }]],
            },
        });

        const result = await Effect.runPromise(retainRecentOtel().pipe(Effect.provide(db.layer)));

        expect(result.deletedByTable).toEqual({
            otel_metric_point: 1,
            otel_span: 3,
            otel_log_event: 5,
        });
        expect(result.deletedEdges).toBe(2);
    });
});
