/**
 * P3.6 tests: fetchSkillsWeighted data layer, against a REAL published DuckDB
 * cache fixture.
 *
 * `Judgment` (spar-session ids + role weights) is a separate sqlite store
 * untouched by the SurrealDB->DuckDB migration, so it keeps the existing
 * `judgmentTestLayer` stub - the interesting behavior under test (invocation
 * aggregation, tombstone/synthetic exclusion, the `session NOT IN (...)` spar
 * filter, the `recovered_by JOIN turn` latency pass) all run against a real
 * DuckDB, not a SQL-text dispatcher.
 */
import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { fetchSkillsWeighted, type SkillsWeightedParams } from "./skills-weighted.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skills-weighted");

interface RoleRow { readonly skill_id: string; readonly role_name: string; readonly effective_weight: number }

const runWeighted = (
    snapshotPath: string,
    params: SkillsWeightedParams = {},
    opts: { readonly sparSessionIds?: readonly string[]; readonly roleRows?: readonly RoleRow[] } = {},
) =>
    Effect.runPromise(
        fetchSkillsWeighted(params).pipe(
            Effect.provide(
                Layer.mergeAll(
                    readFixture(snapshotPath, dylibPath),
                    judgmentTestLayer((sql) => {
                        if (sql.includes("FROM session_label")) {
                            return (opts.sparSessionIds ?? []).map((session_id) => ({ session_id }));
                        }
                        if (sql.includes("JOIN role")) return opts.roleRows ?? [];
                        return [];
                    }),
                ),
            ),
        ),
    );

const SKILL = (overrides: Partial<Record<string, unknown>> & { id: string; name: string }) => ({
    scope: "user",
    dir_path: `/skills/${overrides.name}`,
    content_hash: `hash-${overrides.id}`,
    bytes: 100,
    ...overrides,
});

const INVOKED = (id: string, out_id: string, session: string, ts: Date) => ({
    id,
    in_id: "t1",
    out_id,
    ts,
    session,
});

describe("fetchSkillsWeighted", () => {
    dtest("ranks rows by score DESC, summing multi-role weights (floor 1.0)", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-rank-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [
                        SKILL({ id: "sk-tdd", name: "superpowers:tdd" }),
                        SKILL({ id: "sk-caveman", name: "caveman" }),
                        SKILL({ id: "sk-worktree", name: "worktree-read-strategy" }),
                    ]);
                    yield* w.putMany("invoked", [
                        ...Array.from({ length: 124 }, (_, i) => INVOKED(`i-tdd-${i}`, "sk-tdd", `s-tdd-${i % 45}`, new Date())),
                        ...Array.from({ length: 87 }, (_, i) => INVOKED(`i-cave-${i}`, "sk-caveman", `s-cave-${i % 30}`, new Date())),
                        ...Array.from({ length: 62 }, (_, i) => INVOKED(`i-wt-${i}`, "sk-worktree", `s-wt-${i % 12}`, new Date())),
                    ]);
                }),
            ),
        );

        const result = await runWeighted(fixture.snapshotPath, {}, {
            roleRows: [
                { skill_id: "sk-tdd", role_name: "framing", effective_weight: 1.0 },
                { skill_id: "sk-tdd", role_name: "execution", effective_weight: 1.0 },
                { skill_id: "sk-caveman", role_name: "execution-mode", effective_weight: 1.0 },
            ],
        });

        expect(result.rows[0]).toMatchObject({ skill_name: "superpowers:tdd", score: 248, weight: 2.0, roles: ["framing", "execution"] });
        expect(result.rows[1]).toMatchObject({ skill_name: "caveman", score: 87, weight: 1.0 });
        expect(result.rows[2]).toMatchObject({ skill_name: "worktree-read-strategy", score: 62, weight: 1.0, roles: [] });
    });

    dtest("respects the limit param", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-limit-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [
                        SKILL({ id: "sk-a", name: "a" }),
                        SKILL({ id: "sk-b", name: "b" }),
                        SKILL({ id: "sk-c", name: "c" }),
                    ]);
                    yield* w.putMany("invoked", [
                        INVOKED("i1", "sk-a", "s1", new Date()),
                        INVOKED("i2", "sk-b", "s2", new Date()),
                        INVOKED("i3", "sk-c", "s3", new Date()),
                    ]);
                }),
            ),
        );

        const result = await runWeighted(fixture.snapshotPath, { limit: 2 });
        expect(result.rows.length).toBe(2);
    });

    dtest("excludes tombstoned skills from the ranking", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-tombstone-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [
                        SKILL({ id: "sk-live", name: "live", deleted_at: null }),
                        SKILL({ id: "sk-dead", name: "dead", deleted_at: new Date() }),
                    ]);
                    yield* w.putMany("invoked", [
                        INVOKED("i1", "sk-live", "s1", new Date()),
                        INVOKED("i2", "sk-dead", "s2", new Date()),
                    ]);
                }),
            ),
        );

        const result = await runWeighted(fixture.snapshotPath);
        expect(result.rows.map((r) => r.skill_name)).toEqual(["live"]);
    });

    dtest("excludes synthetic provider tools by default; includeTools=true keeps and ranks them", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-synth-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [
                        SKILL({ id: "sk-simplify", name: "simplify" }),
                        SKILL({ id: "sk-tool", name: "codex:exec_command", dir_path: "(synthetic)" }),
                    ]);
                    yield* w.putMany("invoked", [
                        ...Array.from({ length: 47 }, (_, i) => INVOKED(`i-s-${i}`, "sk-simplify", `s-${i % 33}`, new Date())),
                        ...Array.from({ length: 90000 }, (_, i) => INVOKED(`i-t-${i}`, "sk-tool", `t-${i % 600}`, new Date())).slice(0, 200),
                    ]);
                }),
            ),
        );

        const excluded = await runWeighted(fixture.snapshotPath);
        expect(excluded.rows.map((r) => r.skill_name)).toEqual(["simplify"]);

        const included = await runWeighted(fixture.snapshotPath, { includeTools: true });
        expect(included.rows[0]!.skill_name).toBe("codex:exec_command");
    });

    dtest("doctor: no advice below threshold, advice above threshold, synthetic tools excluded unless includeTools", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-doctor-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    // 7 unclassified skills with >=3 invocations each, plus one
                    // synthetic tool that should not count unless includeTools.
                    const skills = Array.from({ length: 7 }, (_, i) => SKILL({ id: `sk-u${i}`, name: `u${i}` }));
                    yield* w.putMany("skill", [...skills, SKILL({ id: "sk-tool", name: "tool", dir_path: "(synthetic)" })]);
                    const invoked = skills.flatMap((s, i) =>
                        Array.from({ length: 5 }, (_, j) => INVOKED(`i-${i}-${j}`, s.id, `s-${i}-${j % 4}`, new Date())),
                    );
                    yield* w.putMany("invoked", [
                        ...invoked,
                        ...Array.from({ length: 5 }, (_, j) => INVOKED(`i-tool-${j}`, "sk-tool", `st-${j}`, new Date())),
                    ]);
                }),
            ),
        );

        const below = await runWeighted(fixture.snapshotPath, { doctorThreshold: 8 });
        expect(below.doctor.advice).toBeNull();
        expect(below.doctor.unclassified_count).toBe(7);

        const above = await runWeighted(fixture.snapshotPath, { doctorThreshold: 5 });
        expect(above.doctor.advice).toContain("axctl skills classify");
        expect(above.doctor.unclassified_count).toBe(7);

        const withTools = await runWeighted(fixture.snapshotPath, { doctorThreshold: 5, includeTools: true });
        expect(withTools.doctor.unclassified_count).toBe(8);
    });

    dtest("handles an empty graph gracefully", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skw-empty-"), dylibPath, () => Effect.void));

        const result = await runWeighted(fixture.snapshotPath);
        expect(result.rows).toHaveLength(0);
        expect(result.doctor.unclassified_count).toBe(0);
        expect(result.doctor.advice).toBeNull();
    });

    dtest("windowDays limits the invocation aggregate to recent rows", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-window-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [SKILL({ id: "sk-a", name: "a" })]);
                    yield* w.putMany("invoked", [
                        INVOKED("i-recent", "sk-a", "s1", new Date()),
                        INVOKED("i-old", "sk-a", "s2", new Date("2020-01-01T00:00:00.000Z")),
                    ]);
                }),
            ),
        );

        const windowed = await runWeighted(fixture.snapshotPath, { windowDays: 7 });
        expect(windowed.rows[0]!.invocations).toBe(1);

        const unwindowed = await runWeighted(fixture.snapshotPath);
        expect(unwindowed.rows[0]!.invocations).toBe(2);
    });

    dtest("excludes spar-variant sessions from the invocation aggregate", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-spar-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [SKILL({ id: "sk-a", name: "a" })]);
                    yield* w.putMany("invoked", [
                        INVOKED("i-normal", "sk-a", "normal-session", new Date()),
                        INVOKED("i-spar", "sk-a", "spar-session", new Date()),
                    ]);
                }),
            ),
        );

        const result = await runWeighted(fixture.snapshotPath, {}, { sparSessionIds: ["spar-session"] });
        expect(result.rows[0]!.invocations).toBe(1);
        expect(result.rows[0]!.session_count).toBe(1);
    });
});

describe("recovery latency (lens E)", () => {
    const withRecovery = (w: CacheWriteService) =>
        Effect.gen(function* () {
            yield* w.putMany("skill", [SKILL({ id: "sk-tdd", name: "superpowers:tdd" }), SKILL({ id: "sk-caveman", name: "caveman" })]);
            yield* w.putMany("invoked", [
                INVOKED("i1", "sk-tdd", "sess-abc", new Date()),
                INVOKED("i2", "sk-caveman", "sess-ghi", new Date()),
            ]);
            yield* w.putMany("turn", [
                { id: "turn-abc", session: "sess-abc", seq: 1, ts: new Date(), role: "assistant" },
                { id: "turn-def", session: "sess-def", seq: 1, ts: new Date(), role: "assistant" },
            ]);
            yield* w.putMany("recovered_by", [
                { id: "r1", in_id: "turn-abc", out_id: "sk-tdd", ts: new Date() },
                { id: "r2", in_id: "turn-def", out_id: "sk-tdd", ts: new Date() },
            ]);
            yield* w.putMany("otel_log_event", [
                { id: "e1", harness: "claude", event_name: "x", session_id: "sess-abc", duration_ms: 4000, observed_at: new Date() },
                { id: "e2", harness: "claude", event_name: "x", session_id: "sess-def", duration_ms: 6000, observed_at: new Date() },
            ]);
        });

    dtest("computes median_recovery_ms across recovery sessions; null for skills with no recovery edges", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skw-recovery-"), dylibPath, withRecovery));

        const result = await runWeighted(fixture.snapshotPath);
        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;
        const caveman = result.rows.find((r) => r.skill_name === "caveman")!;

        // median of [4000, 6000] = 5000
        expect(tdd.median_recovery_ms).toBe(5000);
        expect(caveman.median_recovery_ms).toBeNull();
    });

    dtest("sessions with no telemetry data do not contribute to the median", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-skw-recovery-partial-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* w.putMany("skill", [SKILL({ id: "sk-tdd", name: "superpowers:tdd" })]);
                    yield* w.putMany("invoked", [INVOKED("i1", "sk-tdd", "s1", new Date())]);
                    yield* w.putMany("turn", [
                        { id: "turn-s1", session: "s1", seq: 1, ts: new Date(), role: "assistant" },
                        { id: "turn-s2", session: "s2", seq: 1, ts: new Date(), role: "assistant" },
                        { id: "turn-s3", session: "s3-no-telemetry", seq: 1, ts: new Date(), role: "assistant" },
                    ]);
                    yield* w.putMany("recovered_by", [
                        { id: "r1", in_id: "turn-s1", out_id: "sk-tdd", ts: new Date() },
                        { id: "r2", in_id: "turn-s2", out_id: "sk-tdd", ts: new Date() },
                        { id: "r3", in_id: "turn-s3", out_id: "sk-tdd", ts: new Date() },
                    ]);
                    yield* w.putMany("otel_log_event", [
                        { id: "e1", harness: "claude", event_name: "x", session_id: "s1", duration_ms: 1000, observed_at: new Date() },
                        { id: "e2", harness: "claude", event_name: "x", session_id: "s2", duration_ms: 3000, observed_at: new Date() },
                    ]);
                }),
            ),
        );

        const result = await runWeighted(fixture.snapshotPath);
        const tdd = result.rows.find((r) => r.skill_name === "superpowers:tdd")!;
        // median of [1000, 3000] = 2000 (s3-no-telemetry absent -> not counted)
        expect(tdd.median_recovery_ms).toBe(2000);
    });
});
