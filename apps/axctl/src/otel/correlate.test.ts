import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { correlateOrphanOtel } from "./correlate.ts";

const UUID = "019fbf3f-9241-40c3-b699-e1f62e7c5341";

/**
 * Stub the four query shapes the pass issues, in order:
 *   1. SELECT id FROM session            -> existing sessions (bare-uuid set)
 *   2. SELECT in FROM telemetry_of       -> already-linked sessions
 *   3..N SELECT id, session_id FROM <otel table> ... GROUP BY session_id
 * GROUP BY collapses `id` into an array, which the stub mirrors.
 */
const makeDb = (opts: {
    sessions?: unknown[];
    linked?: unknown[];
    metric?: Array<{ id: unknown; session_id: unknown }>;
    span?: Array<{ id: unknown; session_id: unknown }>;
    log?: Array<{ id: unknown; session_id: unknown }>;
}) => {
    const sql: string[] = [];
    const layer = Layer.succeed(SurrealClient, {
        query: <T>(q: string) => {
            sql.push(q);
            if (/FROM session;/.test(q)) {
                return Effect.succeed([(opts.sessions ?? []).map((id) => ({ id }))] as unknown as T);
            }
            if (/FROM telemetry_of;/.test(q)) {
                return Effect.succeed([(opts.linked ?? []).map((i) => ({ in: i }))] as unknown as T);
            }
            if (/otel_metric_point/.test(q)) return Effect.succeed([[...(opts.metric ?? [])]] as unknown as T);
            if (/otel_span/.test(q)) return Effect.succeed([[...(opts.span ?? [])]] as unknown as T);
            if (/otel_log_event/.test(q)) return Effect.succeed([[...(opts.log ?? [])]] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);
    return { layer, sql };
};

describe("correlateOrphanOtel", () => {
    test("RELATEs a session to its representative metric row", async () => {
        const { layer, sql } = makeDb({
            sessions: [`session:⟨${UUID}⟩`],
            metric: [{ id: [`otel_metric_point:⟨a|b|${UUID}|||t⟩`], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("telemetry_of");
        expect(all).toContain("otel_metric_point:");
    });

    test("handles a RecordId object id shape (real-SDK case)", async () => {
        const { layer, sql } = makeDb({
            sessions: [{ tb: "session", id: UUID }],
            metric: [{ id: [{ tb: "otel_metric_point", id: "m1" }], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        const all = sql.join("\n");
        expect(all).toContain("RELATE session:");
        expect(all).toContain("m1");
    });

    test("is session-grain: one RELATE even with many rows for the session", async () => {
        const { layer, sql } = makeDb({
            sessions: [`session:⟨${UUID}⟩`],
            // GROUP BY already collapses to one row per session; the id array holds all members.
            metric: [{ id: [`otel_metric_point:r1`, `otel_metric_point:r2`], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        const relates = sql.filter((q) => q.startsWith("RELATE"));
        expect(relates.length).toBe(1);
    });

    test("skips a session that already has a telemetry_of edge (idempotent)", async () => {
        const { layer, sql } = makeDb({
            sessions: [`session:⟨${UUID}⟩`],
            linked: [`session:⟨${UUID}⟩`],
            metric: [{ id: [`otel_metric_point:m1`], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        expect(sql.join("\n")).not.toContain("RELATE");
    });

    test("skips otel rows whose session_id has no matching session", async () => {
        const { layer, sql } = makeDb({
            sessions: [], // no sessions exist
            metric: [{ id: [`otel_metric_point:m1`], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        expect(sql.join("\n")).not.toContain("RELATE");
    });

    test("does not relate the same session twice across tables", async () => {
        const { layer, sql } = makeDb({
            sessions: [`session:⟨${UUID}⟩`],
            metric: [{ id: [`otel_metric_point:m1`], session_id: UUID }],
            log: [{ id: [`otel_log_event:l1`], session_id: UUID }],
        });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        const relates = sql.filter((q) => q.startsWith("RELATE"));
        expect(relates.length).toBe(1);
        expect(relates[0]).toContain("otel_metric_point:"); // first table wins
    });

    test("no telemetry → no RELATE", async () => {
        const { layer, sql } = makeDb({ sessions: [`session:⟨${UUID}⟩`] });
        await Effect.runPromise(correlateOrphanOtel().pipe(Effect.provide(layer)));
        expect(sql.join("\n")).not.toContain("RELATE");
    });
});
