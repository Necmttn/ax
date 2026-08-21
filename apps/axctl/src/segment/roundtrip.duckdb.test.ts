/**
 * The #902 round-trip, AGAINST THE SHIPPED ICU-less libduckdb (spec [R#7]):
 * seed store A -> `runSegmentExport` (COPY TO on the READ_ONLY snapshot
 * connection) -> `planSegmentImport` + `runSegmentImport` into a fresh store
 * B -> read B back and check rows, stripped enrichment, TIMESTAMP fidelity,
 * the watermark handshake mark, and idempotency.
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { importedMarkPath } from "@ax/lib/duckdb/watermark";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { CacheRead, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { runSegmentExport } from "./export.ts";
import { planSegmentImport, runSegmentImport, type SegmentImportResult } from "./import.ts";
import { ddlHash } from "./contract.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("segment round-trip", { requireFts: true });

const T0 = new Date("2026-08-01T10:00:00.000Z");
const RAW_FILE = "/machines/a/transcripts/seg-s1.jsonl";
const SOURCE_SHA = "a".repeat(64);

const sha256 = async (path: string): Promise<string> => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(path).arrayBuffer());
    return hasher.digest("hex");
};

const seedStoreA = (write: CacheWriteService) =>
    Effect.gen(function* () {
        // In-scope session with machine-local enrichment set (must be stripped).
        yield* write.put("session", {
            id: "seg-s1", source: "claude", started_at: T0, raw_file: RAW_FILE,
            project: "local-project", cwd: "/machines/a/repo", reasoning_effort: "high",
        });
        // Spawned child - export must pull it in as a descendant.
        yield* write.put("session", { id: "seg-s3", source: "claude-subagent", started_at: T0 });
        yield* write.put("spawned", { id: "sp1", in_id: "seg-s1", out_id: "seg-s3", ts: T0 });
        // Out-of-scope session that must NOT ride.
        yield* write.put("session", { id: "seg-s2", source: "claude", started_at: T0 });

        yield* write.put("turn", {
            id: "t1", session: "seg-s1", seq: 1, ts: T0, role: "user",
            text: "do the thing", has_tool_use: false, has_error: false, intent_kind: "task",
        });
        yield* write.put("turn", {
            id: "t2", session: "seg-s1", seq: 2, ts: T0, role: "assistant",
            text: "done", has_tool_use: true, has_error: false,
        });
        yield* write.put("turn", {
            id: "t3", session: "seg-s2", seq: 1, ts: T0, role: "user",
            text: "other", has_tool_use: false, has_error: false,
        });
        yield* write.put("tool_call", {
            id: "tc1", session: "seg-s1", turn: "t2", name: "Read", ts: T0, has_error: false,
        });
        yield* write.put("read_file", { id: "rf1", in_id: "tc1", out_id: "file:x", ts: T0, path_seen: "x.ts" });
        yield* write.put("invoked", {
            id: "iv1", in_id: "t2", out_id: "skill:demo", ts: T0, session: "seg-s1",
            turn_has_error: false, was_corrected: true, turn_index: 2, total_turns: 2, is_first: true,
        });
        yield* write.put("session_token_usage", {
            id: "stu1", session: "seg-s1", source: "claude", estimated_tokens: 100,
            transcript_bytes: 2048, ts: T0, estimated_cost_usd: 1.25, pricing_source: "catalog",
        });
        yield* write.put("turn_token_usage", {
            id: "ttu1", session: "seg-s1", turn: "t2", seq: 2, source: "claude",
            estimated_tokens: 60, usage_source: "provider", usage_quality: "exact",
            ts: T0, estimated_cost_usd: 0.5,
        });
        // The transcript file behind seg-s1, with a stored content sha - the
        // export must carry it as a source_files handshake entry.
        yield* write.put("ingest_file_state", {
            id: "ifs1", path: RAW_FILE, source_kind: "claude_transcript",
            mtime_ms: 1000, size: 2048, sha: SOURCE_SHA,
        });
    });

describe("segment export -> import round-trip on the shipped dylib", () => {
    dtest("event rows travel, enrichment does not, marks + timestamps land", async () => {
        const outDir = tempDir("ax-segment-out-");
        const fixtureA = await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-a-"), dylibPath, seedStoreA),
        );

        const exported = await readThroughFixture(
            fixtureA,
            dylibPath,
            runSegmentExport({ sessions: ["seg-s1"], outDir, axVersion: "0.0.0-test" }),
        );
        // Descendant expansion: seg-s1 + spawned seg-s3, never seg-s2.
        expect(exported.sessions).toBe(2);
        expect(exported.sourceFiles).toBe(1);
        const byTable = new Map(exported.tables.map((entry) => [entry.table, entry]));
        expect(byTable.get("session")?.rows).toBe(2);
        expect(byTable.get("turn")?.rows).toBe(2);
        expect(byTable.get("tool_call")?.rows).toBe(1);
        expect(byTable.get("spawned")?.rows).toBe(1);

        // Stripped-at-export proof, on the bytes: no enrichment keys at all.
        const sessionLines = (await Bun.file(`${outDir}/session.ndjson`).text()).trim().split("\n");
        expect(sessionLines.length).toBe(2);
        for (const line of sessionLines) {
            const row = JSON.parse(line) as Record<string, unknown>;
            expect("project" in row).toBe(false);
            expect("cwd" in row).toBe(false);
            expect("reasoning_effort" in row).toBe(false);
        }
        const manifest = JSON.parse(await Bun.file(`${outDir}/manifest.json`).text()) as {
            source_files: readonly { source_kind: string; sha: string }[];
        };
        expect(manifest.source_files).toEqual([
            expect.objectContaining({ source_kind: "claude_transcript", sha: SOURCE_SHA }),
        ]);

        // Import into a FRESH store, twice (idempotency).
        let result: SegmentImportResult | null = null;
        const fixtureB = await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-b-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const plan = yield* planSegmentImport(outDir);
                    expect(plan.ddlMismatch).toBe(false);
                    result = yield* runSegmentImport(write, plan);
                    yield* runSegmentImport(write, plan);
                }),
            ),
        );
        expect(result).not.toBeNull();
        const imported = result as unknown as SegmentImportResult;
        expect(imported.sessions).toBe(2);
        expect(imported.marksWritten).toBe(1);
        expect(imported.rederiveSinceDays).toBeGreaterThan(0);
        expect(imported.rederiveStages.length).toBeGreaterThan(5);

        const Row = Schema.Struct({ v: Schema.NullOr(Schema.String) });
        const Num = Schema.Struct({ v: Schema.NullOr(Schema.Number) });
        await readThroughFixture(fixtureB, dylibPath, Effect.gen(function* () {
            const cache = yield* CacheRead;
            const one = <S extends Schema.Top>(schema: S, sql: string) =>
                cache.rows(schema, sql).pipe(Effect.map((rows) => rows[0]));

            expect((yield* one(Num, "SELECT CAST(count(*) AS DOUBLE) AS v FROM session"))?.v).toBe(2);
            expect((yield* one(Num, "SELECT CAST(count(*) AS DOUBLE) AS v FROM turn"))?.v).toBe(2);
            expect((yield* one(Num, "SELECT CAST(count(*) AS DOUBLE) AS v FROM tool_call"))?.v).toBe(1);
            // Enrichment did not travel; defaults filled the stripped NOT NULLs.
            expect((yield* one(Row, "SELECT project AS v FROM session WHERE id = 'seg-s1'"))?.v).toBeNull();
            expect((yield* one(Row, "SELECT intent_kind AS v FROM turn WHERE id = 't1'"))?.v).toBeNull();
            expect((yield* one(Row, "SELECT CAST(was_corrected AS VARCHAR) AS v FROM invoked WHERE id = 'iv1'"))?.v).toBe("false");
            expect((yield* one(Row, "SELECT pricing_source AS v FROM session_token_usage WHERE id = 'stu1'"))?.v).toBeNull();
            // RETRACTED (#937/#966): turn cost no longer rides - it is an
            // enrichment column now; the importer's re-derive (cost backfill
            // covers turn rows) prices it against the LOCAL catalog.
            expect((yield* one(Num, "SELECT estimated_cost_usd AS v FROM turn_token_usage WHERE id = 'ttu1'"))?.v).toBeNull();
            // TIMESTAMP fidelity through COPY TO JSON -> read_ndjson.
            expect((yield* one(Num, "SELECT CAST(epoch_ms(ts) AS DOUBLE) AS v FROM turn WHERE id = 't1'"))?.v).toBe(T0.getTime());
            // The watermark handshake mark, keyed by content.
            const mark = yield* one(
                Row,
                `SELECT sha AS v FROM ingest_file_state WHERE path = '${importedMarkPath("claude_transcript", SOURCE_SHA)}'`,
            );
            expect(mark?.v).toBe(SOURCE_SHA);
        }));
    });

    dtest("a tampered table file fails validation; a foreign ddl_hash flags the --yes gate", async () => {
        const outDir = tempDir("ax-segment-tamper-");
        const fixtureA = await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-a2-"), dylibPath, seedStoreA),
        );
        await readThroughFixture(
            fixtureA,
            dylibPath,
            runSegmentExport({ sessions: ["seg-s1"], outDir, axVersion: "0.0.0-test" }),
        );

        const manifestPath = `${outDir}/manifest.json`;
        const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { ddl_hash: string };
        await Bun.write(manifestPath, JSON.stringify({ ...manifest, ddl_hash: "f".repeat(64) }));
        const mismatch = await Effect.runPromise(planSegmentImport(outDir));
        expect(mismatch.ddlMismatch).toBe(true);

        await Bun.write(`${outDir}/turn.ndjson`, `{"id":"evil"}\n`);
        const tampered = await Effect.runPromise(planSegmentImport(outDir).pipe(Effect.flip));
        expect(String(tampered)).toContain("turn.ndjson does not match");
    });

    dtest("sessions without a start time use a full-history re-derive window", async () => {
        const outDir = tempDir("ax-segment-null-time-");
        const fixtureA = await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-null-time-a-"), dylibPath, (write) =>
                write.put("session", {
                    id: "null-time-session",
                    source: "claude",
                    started_at: null,
                }),
            ),
        );
        await readThroughFixture(
            fixtureA,
            dylibPath,
            runSegmentExport({ sessions: ["null-time-session"], outDir, axVersion: "0.0.0-test" }),
        );

        let imported: SegmentImportResult | null = null;
        await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-null-time-b-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const plan = yield* planSegmentImport(outDir);
                    imported = yield* runSegmentImport(write, plan);
                }),
            ),
        );

        expect(imported).not.toBeNull();
        expect(imported!.rederiveStages.length).toBeGreaterThan(0);
        expect(imported!.rederiveSinceDays).not.toBeNull();
        expect(imported!.rederiveSinceDays).toBeGreaterThan(20_000);
    });

    dtest("a failed table load rolls back all earlier tables", async () => {
        const segmentDir = tempDir("ax-segment-rollback-");
        const sessionFile = `${segmentDir}/session.ndjson`;
        const turnFile = `${segmentDir}/turn.ndjson`;
        await Bun.write(
            sessionFile,
            `${JSON.stringify({
                id: "partly-imported",
                source: "claude",
                started_at: "2026-08-01T00:00:00.000Z",
            })}\n`,
        );
        await Bun.write(
            turnFile,
            `${JSON.stringify({
                id: "bad-turn",
                session: "partly-imported",
                seq: "not-a-bigint",
                ts: "2026-08-01T00:00:00.000Z",
                role: "user",
            })}\n`,
        );
        await Bun.write(
            `${segmentDir}/manifest.json`,
            `${JSON.stringify({
                segment_version: 1,
                created_at: "2026-08-21T00:00:00.000Z",
                ax_version: "0.0.0-test",
                ddl_hash: ddlHash(),
                scope: { kind: "sessions", sessions: ["partly-imported"], since_days: null },
                tables: [
                    {
                        table: "session",
                        rows: 1,
                        sha256: await sha256(sessionFile),
                        columns: ["id", "source", "started_at"],
                    },
                    {
                        table: "turn",
                        rows: 1,
                        sha256: await sha256(turnFile),
                        columns: ["id", "session", "seq", "ts", "role"],
                    },
                ],
                source_files: [],
                notes: { cost_columns: "test", enrichment_stripped: true },
            }, null, 2)}\n`,
        );

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-segment-rollback-target-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const plan = yield* planSegmentImport(segmentDir);
                    const failure = yield* runSegmentImport(write, plan).pipe(Effect.flip);
                    expect(String(failure)).toContain("loading turn");

                    const Count = Schema.Struct({ n: Schema.Number });
                    const rows = yield* write.rows(
                        Count,
                        "SELECT CAST(count(*) AS DOUBLE) AS n FROM session WHERE id = 'partly-imported'",
                    );
                    expect(rows[0]?.n).toBe(0);
                }),
            ),
        );
        expect(fixture.snapshotPath).toBeTruthy();
    });
});
