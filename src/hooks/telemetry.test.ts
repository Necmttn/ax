import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import { DbError } from "../lib/errors.ts";
import { recordHookFire } from "./telemetry.ts";

interface RecordedCall {
    readonly id: RecordId;
    readonly content: Record<string, unknown>;
}

function fakeClient(): { client: SurrealClientShape; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const client: SurrealClientShape = {
        query: () => Effect.succeed([] as unknown as never),
        upsert: (id, content) =>
            Effect.sync(() => {
                calls.push({ id, content });
            }),
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
    return { client, calls };
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
        const { client, calls } = fakeClient();

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

        expect(calls).toHaveLength(2);
        expect(calls[0]!.id.toString()).toMatch(/^hook_fire:[0-9a-f]{16}$/);
        expect(calls[0]!.content.file_path).toBe("src/a.ts");
        expect(calls[1]!.content.file_path).toBe("src/b.ts");
        // Different file path → different deterministic id.
        expect(calls[0]!.id.toString()).not.toBe(calls[1]!.id.toString());
    });

    test("populates harness, event, decision, latency, and prior session metadata", async () => {
        const { client, calls } = fakeClient();
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

        const row = calls[0]!.content;
        expect(row.harness).toBe("claude");
        expect(row.event).toBe("pre-edit");
        expect(row.inject).toBe(true);
        expect(row.reason).toBe("high_signal");
        expect(row.latency_ms).toBe(137);
        expect(row.kind).toBe("hook_fire");
        expect(row.ok).toBe(true);
        expect(row.prior_sessions_considered).toBe(4);
        // Top 3 sessions only, in order.
        const top = row.top_prior_sessions as RecordId[];
        expect(top).toHaveLength(3);
        expect(top[0]!.toString()).toBe("session:s1");
        expect(top[2]!.toString()).toBe("session:s3");
    });

    test("clips task_excerpt to 240 chars", async () => {
        const { client, calls } = fakeClient();
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

        expect((calls[0]!.content.task_excerpt as string).length).toBeLessThanOrEqual(240);
    });

    test("emits no rows when input.files is empty", async () => {
        const { client, calls } = fakeClient();

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

        expect(calls).toHaveLength(0);
    });

    test("swallows db errors so the hook still emits output", async () => {
        const failing: SurrealClientShape = {
            query: () => Effect.succeed([] as unknown as never),
            upsert: () =>
                Effect.fail(new DbError({ operation: "upsert", message: "db is down" })),
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
