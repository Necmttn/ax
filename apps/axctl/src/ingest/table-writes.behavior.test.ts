// apps/axctl/src/ingest/table-writes.behavior.test.ts
/**
 * Behavioral half of the event-layer freeze enforcement (#893 slice 1,
 * #897): run REGISTERED stages against a real temp DuckDB fixture and diff
 * per-table CONTENT digests before/after. Any table whose digest changed
 * must be declared in the stage's `meta.writes`.
 *
 * The digest is `bit_xor(hash(row))`, not a row count - the known
 * undeclared-write failure modes are UPDATEs, which change no count [R#4]
 * (pinned below by the invoked-positions case: count constant, hash moves).
 *
 * Coverage is a deliberate SUBSET: six stages whose fixtures are cheap,
 * chosen to exercise each write mode (parse via the shared normalized batch,
 * enrich via UPDATE stamping, derive, bookkeep) plus the
 * session-health-writes-session_token_usage exception. The static test in
 * stage/table-writes.test.ts covers every declaration; stages without a
 * fixture here simply have no behavioral witness yet.
 */
import { describe, expect } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { DUCKDB_TABLE_LAYERS } from "@ax/schema/duckdb-tables";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { StageDef } from "./stage/registry.ts";
import { ALL_STAGES } from "./stage/registry.ts";
import type { BaseStageStats } from "./stage/types.ts";
import { IngestContext } from "./stage/types.ts";
import { piStage } from "./pi.ts";
import { invokedPositionsStage } from "./backfill-invoked-positions.ts";
import { outcomesStage } from "./outcomes.ts";
import { contentTypesStage } from "./derive-content-types.ts";
import { sessionHealthStage } from "./session-health.ts";
import { deriveMetricsStage } from "./derive-metrics.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("table-writes behavior", { requireFts: true });

const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });

type Digest = ReadonlyMap<string, string>;

const digestAllTables = (write: CacheWriteService): Effect.Effect<Digest, unknown> =>
    Effect.gen(function* () {
        const digest = new Map<string, string>();
        for (const table of DUCKDB_TABLE_LAYERS.keys()) {
            const result = yield* write.raw(
                `SELECT CAST(count(*) AS DOUBLE) AS n, CAST(coalesce(bit_xor(hash(t)), 0) AS VARCHAR) AS h FROM "${table}" AS t`,
            );
            const row = result.rows[0] as { n: number; h: string };
            digest.set(table, `${row.n}:${row.h}`);
        }
        return digest;
    });

const changedTables = (before: Digest, after: Digest): readonly string[] =>
    [...after.keys()].filter((table) => before.get(table) !== after.get(table));

/** Run one registered stage inside a fresh fixture store and assert every
 *  table whose content digest moved is declared in `meta.writes`. */
const assertStageWrites = (
    stage: StageDef<BaseStageStats, unknown, unknown>,
    label: string,
    seed: (write: CacheWriteService) => Effect.Effect<void, unknown, unknown>,
    provide: <A, E>(effect: Effect.Effect<A, E, unknown>) => Effect.Effect<A, E, never>,
): Promise<{ changed: readonly string[]; before: Digest; after: Digest }> => {
    // Identity, not key equality: the descriptor exercised IS the registered one.
    expect((ALL_STAGES as readonly unknown[]).includes(stage)).toBe(true);
    let outcome: { changed: readonly string[]; before: Digest; after: Digest } | undefined;
    return runWithPlatform(
        publishCacheFixture(tempDir(`ax-tw-${label}-`), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* provide(seed(write));
                const before = yield* digestAllTables(write);
                yield* provide(stage.run(ctx, write));
                const after = yield* digestAllTables(write);
                const changed = changedTables(before, after);
                const declared = new Set(stage.meta.writes.map((w) => w.table));
                const undeclared = changed.filter((table) => !declared.has(table));
                expect(undeclared, `${label}: undeclared writes`).toEqual([]);
                outcome = { changed, before, after };
            }),
        ),
    ).then(() => outcome!);
};

const provideFixture = (paths: Record<string, string>) =>
    <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
        effect.pipe(Effect.provide(AxConfigTest({ paths })), Effect.provide(FixturePlatform)) as Effect.Effect<A, E, never>;

const provideNone = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
    effect.pipe(Effect.provide(FixturePlatform)) as Effect.Effect<A, E, never>;

const noSeed = (_write: CacheWriteService) => Effect.void;

const piLines = (id: string) => [
    { type: "session", version: 3, id, timestamp: "2026-06-01T10:00:00Z", cwd: "/repo" },
    { type: "message", id: `${id}-m1`, parentId: null, timestamp: "2026-06-01T10:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello there" }] } },
    { type: "message", id: `${id}-m2`, parentId: `${id}-m1`, timestamp: "2026-06-01T10:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
].map((row) => JSON.stringify(row)).join("\n");

describe("event-layer write contract (behavioral)", () => {
    dtest("pi stage (parse family): every touched table is declared", async () => {
        const piDir = tempDir("ax-tw-pi-src-");
        await Bun.write(join(piDir, "one.jsonl"), piLines("pi-tw-1"));
        const { changed } = await assertStageWrites(piStage, "pi", noSeed, provideFixture({ piDir }));
        // The fixture must actually exercise the parse path.
        expect(changed).toContain("session");
        expect(changed).toContain("turn");
        expect(changed).toContain("ingest_file_state");
    }, 60_000);

    dtest("invoked-positions (enrich): UPDATE moves the digest at constant count", async () => {
        const seed = (write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date("2026-06-01T10:00:00Z") });
                yield* write.put("turn", { id: "t1", session: "s1", role: "user", seq: 1, ts: new Date("2026-06-01T10:00:01Z") });
                yield* write.put("skill", { id: "sk1", name: "demo-skill", scope: "user", dir_path: "/tmp/sk", content_hash: "h1" });
                yield* write.put("invoked", { id: "inv1", in_id: "t1", out_id: "sk1", session: "s1", ts: new Date("2026-06-01T10:00:01Z") });
            });
        const { changed, before, after } = await assertStageWrites(
            invokedPositionsStage, "invoked-positions", seed, provideNone,
        );
        expect(changed).toEqual(["invoked"]);
        // The [R#4] pin: same row count, different content hash.
        const [countBefore] = before.get("invoked")!.split(":");
        const [countAfter] = after.get("invoked")!.split(":");
        expect(countAfter).toBe(countBefore);
    }, 60_000);

    dtest("outcomes (derive): every touched table is declared", async () => {
        const seed = (write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date("2026-06-01T10:00:00Z") });
                yield* write.put("tool", { id: "tool-bash", name: "Bash", kind: "cli" });
                yield* write.put("tool_call", {
                    id: "tc1", session: "s1", tool: "tool-bash", name: "Bash", seq: 1,
                    ts: new Date("2026-06-01T10:00:02Z"), command_text: "bun test apps", exit_code: 0,
                });
            });
        const { changed } = await assertStageWrites(outcomesStage, "outcomes", seed, provideNone);
        expect(changed).toContain("command_outcome");
    }, 60_000);

    dtest("content-types (derive): every touched table is declared", async () => {
        const seed = (write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date("2026-06-01T10:00:00Z") });
                yield* write.put("tool", { id: "tool-read", name: "Read", kind: "agent" });
                yield* write.put("tool_call", {
                    id: "tc1", session: "s1", tool: "tool-read", name: "Read", seq: 1,
                    ts: new Date("2026-06-01T10:00:02Z"), output_json: JSON.stringify({ text: "file body" }),
                });
            });
        const { changed } = await assertStageWrites(contentTypesStage, "content-types", seed, provideNone);
        expect(changed).toContain("content_type");
    }, 60_000);

    dtest("session-health (derive incl. the session_token_usage exception)", async () => {
        const seed = (write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date("2026-06-01T10:00:00Z"), ended_at: new Date("2026-06-01T11:00:00Z") });
                yield* write.put("turn", { id: "t1", session: "s1", role: "user", seq: 1, ts: new Date("2026-06-01T10:00:01Z"), text: "do the thing" });
                yield* write.put("turn", { id: "t2", session: "s1", role: "assistant", seq: 2, ts: new Date("2026-06-01T10:00:05Z"), text: "done" });
            });
        const { changed } = await assertStageWrites(sessionHealthStage, "session-health", seed, provideNone);
        expect(changed).toContain("session_health");
    }, 60_000);

    dtest("derive-metrics (derive + enrich cost backfill)", async () => {
        const seed = (write: CacheWriteService) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date() });
                yield* write.put("session_token_usage", {
                    id: "usage-s1", session: "s1", source: "claude", model: "claude-opus-4-5",
                    estimated_tokens: 1_000_000, transcript_bytes: 4_000_000,
                });
            });
        const { changed } = await assertStageWrites(deriveMetricsStage, "derive-metrics", seed, provideNone);
        expect(changed).toContain("session_metrics");
        // The enrich write: cost backfill UPDATEs the seeded usage row.
        expect(changed).toContain("session_token_usage");
    }, 60_000);
});
