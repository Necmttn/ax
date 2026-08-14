import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { retainRecentOtel } from "./retention.ts";

describe("retainRecentOtel", () => {
    test("deletes rows older than 30 days through primary ids", async () => {
        const db = makeTestSurrealClient();

        await Effect.runPromise(retainRecentOtel().pipe(Effect.provide(db.layer)));

        const sql = db.captured.join("\n");
        for (const table of ["otel_metric_point", "otel_span", "otel_log_event"]) {
            expect(sql).toContain(
                `DELETE ${table} WHERE id IN (SELECT VALUE id FROM ${table} WHERE observed_at < time::now() - 30d);`,
            );
            expect(sql).not.toContain(`DELETE ${table} WHERE observed_at`);
        }
    });
});
