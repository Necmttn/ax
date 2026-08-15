/**
 * The ingest file watermark, against a REAL live database.
 *
 * Everything here goes through `withCacheWrite` while genuinely holding the
 * ingest lock, because that is the only way a writer exists - and because the
 * behaviour under test is a round trip (write a mark, re-read it in a later
 * "run"), which a mock cannot show.
 */
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "../ingest-lock.ts";
import { runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { withCacheWrite, type CacheWriteService } from "./seam.ts";
import {
    fileWatermark,
    watermarkRow,
    watermarkRowId,
    WATERMARK_TABLE,
    type FileWatermark,
} from "./watermark.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache watermark");

const SOURCE = { sourceKind: "claude_transcript", forceEnv: "AX_TEST_REDERIVE" } as const;

/**
 * Run `body` as one ingest "run" against a live database in `dir` - lock held,
 * schema applied, snapshot published. Calling it twice against the same `dir`
 * is what a second ingest run looks like, which is what the watermark exists
 * for.
 */
const asIngestRun = <A>(
    dir: string,
    body: (write: CacheWriteService) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
    runWithPlatform(
        Effect.gen(function* () {
            const path = yield* Path.Path;
            const lockPath = path.join(dir, "ingest.lock");
            const outcome = yield* withIngestLock(
                {
                    lockPath,
                    command: "watermark-test",
                    staleMs: 60_000,
                    onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
                },
                withCacheWrite(
                    {
                        livePath: path.join(dir, "live.duckdb"),
                        lockPath,
                        snapshotPath: path.join(dir, "snapshot.duckdb"),
                        schemaSql: DUCKDB_SCHEMA_SQL,
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    },
                    body,
                ),
            );
            if (outcome._tag !== "completed") throw new Error(`ingest run did not complete: ${outcome._tag}`);
            return outcome.value;
        }) as Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
    );

/** Read the marks a run left behind, as raw rows. */
const MarkRow = Schema.Struct({
    path: Schema.String,
    source_kind: Schema.String,
    mtime_ms: Schema.NullOr(Schema.Number),
    size: Schema.NullOr(Schema.Number),
    sha: Schema.NullOr(Schema.String),
});

const marksIn = (write: CacheWriteService) =>
    write.rows(MarkRow, `SELECT path, source_kind, mtime_ms, size, sha FROM ${WATERMARK_TABLE} ORDER BY source_kind, path`);

describe("watermarkRowId", () => {
    test("is stable for a (source kind, path) pair and separates the two", () => {
        expect(watermarkRowId("claude_transcript", "/a.jsonl")).toBe(
            watermarkRowId("claude_transcript", "/a.jsonl"),
        );
        expect(watermarkRowId("claude_transcript", "/a.jsonl")).not.toBe(
            watermarkRowId("claude_subagent", "/a.jsonl"),
        );
        expect(watermarkRowId("claude_transcript", "/a.jsonl")).not.toBe(
            watermarkRowId("claude_transcript", "/b.jsonl"),
        );
    });

    test("does not concatenate its way into a collision", () => {
        // A naive `${kind}|${path}` digest collides when a kind ends in the
        // separator: ("a|b", "c") and ("a", "b|c") hash the same string.
        expect(watermarkRowId("a|b", "c")).not.toBe(watermarkRowId("a", "b|c"));
    });
});

describe("watermarkRow", () => {
    test("carries only the fields the caller supplied, with the rest NULL", () => {
        const row = watermarkRow("git_repo", "/w/ax", { sha: "abc123", sinceDays: 30 });

        expect(row.id).toBe(watermarkRowId("git_repo", "/w/ax"));
        expect(row.path).toBe("/w/ax");
        expect(row.source_kind).toBe("git_repo");
        expect(row.sha).toBe("abc123");
        expect(row.since_days).toBe(30);
        expect(row.mtime_ms).toBeNull();
        // Every row carries the same column set, whatever the caller passed -
        // `putMany` refuses a ragged batch.
        expect(Object.keys(row).sort()).toEqual(
            Object.keys(watermarkRow("pricing", "__pricing__", {})).sort(),
        );
    });
});

describe("fileWatermark", () => {
    const load = (write: CacheWriteService): Effect.Effect<FileWatermark, unknown, never> =>
        fileWatermark(write, SOURCE) as Effect.Effect<FileWatermark, unknown, never>;

    dtest("an unseen path is changed; a committed one is unchanged", async () => {
        const dir = tempDir("ax-wm-basic-");

        const before = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                const unseen = wm.unchanged("/a.jsonl", 100, 10);
                yield* wm.commit("/a.jsonl", 100, 10);
                return unseen;
            }),
        );
        expect(before).toBe(false);

        // A SECOND run: the mark has to survive the connection, which is the
        // whole point of persisting it.
        const after = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                return {
                    same: wm.unchanged("/a.jsonl", 100, 10),
                    newerMtime: wm.unchanged("/a.jsonl", 101, 10),
                    differentSize: wm.unchanged("/a.jsonl", 100, 11),
                    otherPath: wm.unchanged("/b.jsonl", 100, 10),
                };
            }),
        );
        expect(after).toEqual({
            same: true,
            newerMtime: false,
            differentSize: false,
            otherPath: false,
        });
    });

    dtest("re-committing a path REPLACES its mark rather than duplicating it", async () => {
        const dir = tempDir("ax-wm-replace-");
        await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                yield* wm.commit("/a.jsonl", 100, 10);
            }),
        );
        const rows = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                yield* wm.commit("/a.jsonl", 200, 20);
                return yield* marksIn(write);
            }),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.mtime_ms).toBe(200);
        expect(rows[0]?.size).toBe(20);
    });

    dtest("forceEnv empties the map without touching the stored marks", async () => {
        const dir = tempDir("ax-wm-force-");
        await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                yield* wm.commit("/a.jsonl", 100, 10);
            }),
        );

        process.env[SOURCE.forceEnv] = "1";
        try {
            const forced = await asIngestRun(dir, (write) =>
                Effect.gen(function* () {
                    const wm = yield* load(write);
                    return { unchanged: wm.unchanged("/a.jsonl", 100, 10), rows: yield* marksIn(write) };
                }),
            );
            // Every file re-derives...
            expect(forced.unchanged).toBe(false);
            // ...but a forced run is not a DELETE: the rows stay, and a run that
            // dies halfway must not lose the marks it never got to rewrite.
            expect(forced.rows).toHaveLength(1);
        } finally {
            delete process.env[SOURCE.forceEnv];
        }
    });

    dtest("only this source kind's marks are loaded", async () => {
        const dir = tempDir("ax-wm-kinds-");
        await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                yield* write.put(WATERMARK_TABLE, watermarkRow("some_other_kind", "/a.jsonl", {
                    mtimeMs: 100,
                    size: 10,
                }));
            }),
        );
        const seen = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                return wm.unchanged("/a.jsonl", 100, 10);
            }),
        );

        // Same path, different source kind: this stage has not seen the file.
        expect(seen).toBe(false);
    });

    dtest("row() and commit() write the SAME row", async () => {
        // A stage that batches its marks into one putMany must not drift from a
        // stage that commits them one at a time.
        const dir = tempDir("ax-wm-batch-");
        const rows = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                const wm = yield* load(write);
                yield* wm.commit("/a.jsonl", 100, 10);
                yield* write.putMany(WATERMARK_TABLE, [wm.row("/b.jsonl", 200, 20)]);
                return yield* marksIn(write);
            }),
        );

        expect(rows.map((r) => [r.path, r.mtime_ms, r.size])).toEqual([
            ["/a.jsonl", 100, 10],
            ["/b.jsonl", 200, 20],
        ]);
        expect(new Set(rows.map((r) => r.source_kind))).toEqual(new Set(["claude_transcript"]));
    });

    dtest("a sha watermark round-trips for the non-file kinds", async () => {
        // git / pricing / closure / the metrics passes all store a `sha` under a
        // sentinel path rather than an (mtime,size) pair. They share this row
        // shape so they cannot each invent a different one.
        const dir = tempDir("ax-wm-sha-");
        const rows = await asIngestRun(dir, (write) =>
            Effect.gen(function* () {
                yield* write.put(WATERMARK_TABLE, watermarkRow("closure", "__closure__", { sha: "deadbeef" }));
                return yield* marksIn(write);
            }),
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.sha).toBe("deadbeef");
        expect(rows[0]?.mtime_ms).toBeNull();
    });

    dtest("the DDL refuses two source kinds for ONE path, loudly", async () => {
        // PINNED, NOT FIXED. Every writer keys a watermark by (source_kind,
        // path), but the DDL carries `UNIQUE (path)` alone - so the pair is not
        // in fact free. No two kinds share a path today (the transcript stage
        // walks `<project>/*.jsonl` while the subagent stage walks
        // `<project>/<id>/subagents/agent-*.jsonl`, and every non-file kind uses
        // its own `__sentinel__`), so this is a latent constraint rather than a
        // live bug, and it fails LOUDLY rather than corrupting anything.
        //
        // It is pinned here so a future writer that picks a colliding sentinel
        // path meets this test instead of a mysterious ingest failure. Widening
        // the index to (source_kind, path) is the real fix and belongs to
        // whoever needs it - see REPORT.md.
        const dir = tempDir("ax-wm-collide-");
        const outcome = await asIngestRun(dir, (write) =>
            Effect.result(
                Effect.gen(function* () {
                    yield* write.put(WATERMARK_TABLE, watermarkRow("kind_a", "/shared.jsonl", { sha: "a" }));
                    yield* write.put(WATERMARK_TABLE, watermarkRow("kind_b", "/shared.jsonl", { sha: "b" }));
                }),
            ),
        );

        expect(outcome._tag).toBe("Failure");
    });
});
