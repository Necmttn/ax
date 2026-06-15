import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { correlateOrphanOtel } from "./correlate.ts";

const sql: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(q: string) => {
        sql.push(q);
        if (/otel_metric_point/.test(q) && /SELECT/i.test(q)) {
            return Effect.succeed([[{ id: "otel_metric_point:m1", session_id: "s1" }]] as unknown as T);
        }
        if (/otel_span/.test(q) && /SELECT/i.test(q)) return Effect.succeed([[]] as unknown as T);
        return Effect.succeed([[]] as unknown as T);
    },
} as never);

describe("correlateOrphanOtel", () => {
    test("RELATEs an orphan metric row to its session", async () => {
        sql.length = 0;
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(stubDb)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("telemetry_of");
        expect(all).toContain("otel_metric_point:");
    });

    test("handles RecordId object id shape (real-SDK case)", async () => {
        sql.length = 0;
        // The SurrealDB SDK returns row `id` as a RecordId object { tb, id },
        // not a string. Correlation must extract the key from the object form.
        const objIdDb = Layer.succeed(SurrealClient, {
            query: <T>(q: string) => {
                sql.push(q);
                if (/otel_metric_point/.test(q) && /SELECT/i.test(q)) {
                    return Effect.succeed([[
                        { id: { tb: "otel_metric_point", id: "m1" }, session_id: "s1" },
                    ]] as unknown as T);
                }
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(objIdDb)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("telemetry_of");
        expect(all).toContain("otel_metric_point:");
        expect(all).toContain("m1");
    });

    test("RELATEs an orphan log event row to its session", async () => {
        sql.length = 0;
        const logEventDb = Layer.succeed(SurrealClient, {
            query: <T>(q: string) => {
                sql.push(q);
                if (/otel_log_event/.test(q) && /SELECT/i.test(q)) {
                    return Effect.succeed([[{ id: "otel_log_event:l1", session_id: "s1" }]] as unknown as T);
                }
                return Effect.succeed([[]] as unknown as T);
            },
        } as never);
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(logEventDb)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("telemetry_of");
        expect(all).toContain("otel_log_event:");
    });

    test("no orphans → no RELATE", async () => {
        sql.length = 0;
        // override: both selects return empty by re-importing with a fresh stub
        const emptyDb = Layer.succeed(SurrealClient, {
            query: <T>(q: string) => { sql.push(q); return Effect.succeed([[]] as unknown as T); },
        } as never);
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(emptyDb)));
        expect(sql.join("\n")).not.toContain("RELATE");
    });
});
