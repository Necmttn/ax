import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { DbError } from "../lib/errors.ts";
import { recordHookFire } from "./telemetry.ts";

/**
 * After ADR-0005 the hook telemetry write path no longer calls `db.upsert`;
 * `writeTelemetryRow` builds an `UPSERT` statement and runs it through
 * `executeStatements` → `db.query`. The fake therefore spies on `query`,
 * collecting every emitted SQL string. `upsert` stays on the shape only so
 * the object still satisfies `SurrealClientShape`; it is no longer the
 * assertion target.
 */
function fakeClient(): { client: SurrealClientShape; statements: string[] } {
    const statements: string[] = [];
    const client: SurrealClientShape = {
        query: <T extends unknown[]>(sql: string) => {
            statements.push(sql);
            return Effect.succeed([] as unknown as T);
        },
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
    return { client, statements };
}

const minimalPriorSession = {
    session: "session:s1",
    title: "fix bug",
    project: null,
    source: "claude",
    weight: 9,
    files_touched: 1,
    top_files: [] as readonly string[],
    produced_commits: 1,
    delivery_status: null,
    review_pain: null,
    pr_size: null,
    pr_title: null,
    merged_to_main: true,
    user_turns: 3,
    assistant_turns: 8,
    corrections: 1,
    interruptions: 0,
    duration_ms: null,
    hands_free_ms: null,
    last_seen: null,
};

describe("recordHookFire", () => {
    test("writes one hook_fire row per file in the input", async () => {
        const { client, statements } = fakeClient();

        await Effect.runPromise(
            recordHookFire({
                input: {
                    event: "pre-edit",
                    task: "fix knowledge route tab bug",
                    files: ["src/a.ts", "src/b.ts"],
                    sessionId: "session:s1",
                    format: "claude",
                },
                decision: { inject: true, reason: "high_signal" },
                priorSessions: [minimalPriorSession],
                harness: "claude",
                latencyMs: 42,
                now: new Date("2026-05-17T10:00:00Z"),
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, client))),
        );

        // recordHookFire calls writeTelemetryRow once per file; each one is an
        // executeStatements([oneStatement]) → exactly one db.query call.
        expect(statements).toHaveLength(2);
        expect(statements[0]!).toMatch(/^UPSERT hook_fire:`[0-9a-f]{16}` CONTENT \{/);
        expect(statements[1]!).toMatch(/^UPSERT hook_fire:`[0-9a-f]{16}` CONTENT \{/);
        expect(statements[0]!).toContain('file_path: "src/a.ts"');
        expect(statements[1]!).toContain('file_path: "src/b.ts"');
        // Different file path → different deterministic id (different record key).
        const id0 = statements[0]!.match(/^UPSERT hook_fire:`([0-9a-f]{16})`/)![1];
        const id1 = statements[1]!.match(/^UPSERT hook_fire:`([0-9a-f]{16})`/)![1];
        expect(id0).not.toBe(id1);
    });

    test("populates harness, event, decision, latency, and prior session metadata", async () => {
        const { client, statements } = fakeClient();
        const priors = [
            { ...minimalPriorSession, session: "session:s1" },
            { ...minimalPriorSession, session: "session:s2", weight: 5 },
            { ...minimalPriorSession, session: "session:s3", weight: 2 },
            { ...minimalPriorSession, session: "session:s4", weight: 1 },
        ];

        await Effect.runPromise(
            recordHookFire({
                input: {
                    event: "pre-edit",
                    task: "x",
                    files: ["src/a.ts"],
                    sessionId: "session:s1",
                    format: "claude",
                },
                decision: { inject: true, reason: "high_signal" },
                priorSessions: priors,
                harness: "claude",
                latencyMs: 137,
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, client))),
        );

        const sql = statements[0]!;
        expect(sql).toContain('harness: "claude"');
        expect(sql).toContain('event: "pre-edit"');
        expect(sql).toContain("inject: true");
        expect(sql).toContain('reason: "high_signal"');
        expect(sql).toContain("latency_ms: 137");
        expect(sql).toContain('kind: "hook_fire"');
        expect(sql).toContain("ok: true");
        expect(sql).toContain("prior_sessions_considered: 4");
        // Top 3 sessions only, in order, as native record references.
        expect(sql).toContain(
            "top_prior_sessions: [session:`s1`, session:`s2`, session:`s3`]",
        );
        expect(sql).not.toContain("session:`s4`");
    });

    test("clips task_excerpt to 240 chars", async () => {
        const { client, statements } = fakeClient();
        const longTask = "x".repeat(500);

        await Effect.runPromise(
            recordHookFire({
                input: {
                    event: "pre-edit",
                    task: longTask,
                    files: ["src/a.ts"],
                    format: "plain",
                },
                decision: { inject: false, reason: "no_prior_sessions" },
                priorSessions: [],
                harness: "claude",
                latencyMs: 1,
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, client))),
        );

        const sql = statements[0]!;
        // The clipped excerpt (239 chars + ellipsis) is present; the full
        // 500-char string is not.
        expect(sql).toContain(`task_excerpt: "${"x".repeat(239)}…"`);
        expect(sql).not.toContain("x".repeat(500));
    });

    test("emits no rows when input.files is empty", async () => {
        const { client, statements } = fakeClient();

        await Effect.runPromise(
            recordHookFire({
                input: {
                    event: "pre-edit",
                    task: "x",
                    files: [],
                    format: "plain",
                },
                decision: { inject: false, reason: "no_files" },
                priorSessions: [],
                harness: "claude",
                latencyMs: 1,
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, client))),
        );

        expect(statements).toHaveLength(0);
    });

    test("swallows db errors so the hook still emits output", async () => {
        const failing: SurrealClientShape = {
            query: () =>
                Effect.fail(new DbError({ operation: "query", message: "db is down" })),
            upsert: () => Effect.succeed(undefined),
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as never,
        };

        await Effect.runPromise(
            recordHookFire({
                input: {
                    event: "pre-edit",
                    task: "x",
                    files: ["src/a.ts"],
                    format: "plain",
                },
                decision: { inject: false, reason: "no_prior_sessions" },
                priorSessions: [],
                harness: "claude",
                latencyMs: 1,
            }).pipe(Effect.provide(Layer.succeed(SurrealClient, failing))),
        );
        // No throw = pass. The hook output path must never fail because telemetry failed.
    });
});
