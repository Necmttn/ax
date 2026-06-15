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
