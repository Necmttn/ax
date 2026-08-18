/**
 * The NDJSON spool, against a REAL live database.
 *
 * Everything that matters here is a round trip through `read_ndjson`: that a
 * bigint survives above 2^53, that an ISO-Z timestamp casts into an ICU-less
 * TIMESTAMP column, that a narrower signature cannot NULL a column it never
 * carried, and that flush-then-read equals what `putMany` would have written.
 * None of that is visible to a mock.
 */
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "../ingest-lock.ts";
import { runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { withCacheWrite, type CacheWriteService } from "./seam.ts";
import { makeTableSpool, withTableSpool, type TableSpool } from "./spool.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache spool");

/** One ingest "run" against a live database in `dir` - lock held, schema
 *  applied - mirroring watermark.test.ts. */
const asIngestRun = <A>(
    dir: string,
    body: (write: CacheWriteService, spool: TableSpool, spoolDir: string) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
    runWithPlatform(
        Effect.gen(function* () {
            const path = yield* Path.Path;
            const fs = yield* FileSystem.FileSystem;
            const lockPath = path.join(dir, "ingest.lock");
            const spoolDir = path.join(dir, "spool");
            yield* fs.makeDirectory(spoolDir, { recursive: true });
            const outcome = yield* withIngestLock(
                {
                    lockPath,
                    command: "spool-test",
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
                    (write) => {
                        const spool = makeTableSpool({
                            tables: ["tool", "file", "invoked", "turn_token_usage"],
                            dir: spoolDir,
                        });
                        return body(write, spool, spoolDir);
                    },
                ),
            );
            if (outcome._tag !== "completed") throw new Error(`ingest run did not complete: ${outcome._tag}`);
            return outcome.value;
        }) as Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
    );

describe("makeTableSpool", () => {
    dtest("flush lands buffered rows; a spooled row is invisible before it", async () => {
        const dir = tempDir("spool-basic");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("tool", [
                    { id: "tool:one", name: "Read", provider: "claude" },
                    { id: "tool:two", name: "Edit", provider: "claude" },
                ]);
                expect(spool.pendingRows()).toBe(2);

                const before = yield* write.raw("SELECT count(*) AS n FROM tool");
                expect(before.rows[0]!["n"]).toBe(0n);

                const outcome = yield* spool.flush(write);
                expect(outcome.rows).toBe(2);
                expect(outcome.statements).toBe(1);
                expect(spool.pendingRows()).toBe(0);

                const after = yield* write.raw("SELECT name FROM tool ORDER BY id");
                expect(after.rows.map((r) => r["name"])).toEqual(["Read", "Edit"]);
            }),
        );
    });

    dtest("a bigint above 2^53 round-trips EXACTLY through the NDJSON path", async () => {
        const dir = tempDir("spool-bigint");
        const exact = 9007199254740993n; // 2^53 + 1: a double would corrupt it
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("turn_token_usage", [
                    {
                        id: "ttu:1",
                        session: "s1",
                        turn: "t1",
                        seq: 1,
                        source: "claude",
                        prompt_tokens: exact,
                        estimated_tokens: 0,
                        usage_source: "provider_events",
                        usage_quality: "exact",
                    },
                ]);
                yield* spool.flush(write);
                const got = yield* write.raw("SELECT prompt_tokens FROM turn_token_usage WHERE id = 'ttu:1'");
                expect(got.rows[0]!["prompt_tokens"]).toBe(exact);
            }),
        );
    });

    dtest("a Date lands in a TIMESTAMP column at millisecond precision (ISO-Z parses without ICU)", async () => {
        const dir = tempDir("spool-ts");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("invoked", [
                    {
                        id: "inv:1",
                        in_id: "turn:1",
                        out_id: "skill:1",
                        ts: new Date("2026-08-18T10:20:30.123Z"),
                        turn_has_error: false,
                        was_corrected: false,
                    },
                ]);
                yield* spool.flush(write);
                const got = yield* write.raw("SELECT CAST(ts AS VARCHAR) AS ts_text FROM invoked WHERE id = 'inv:1'");
                expect(got.rows[0]!["ts_text"]).toBe("2026-08-18 10:20:30.123");
            }),
        );
    });

    dtest("same id twice in ONE window dedups last-wins (DuckDB rejects in-statement key dups)", async () => {
        const dir = tempDir("spool-dedup");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("tool", [{ id: "tool:dup", name: "first", provider: "claude" }]);
                spool.append("tool", [{ id: "tool:dup", name: "second", provider: "claude" }]);
                expect(spool.pendingRows()).toBe(1);
                yield* spool.flush(write);
                const got = yield* write.raw("SELECT name FROM tool WHERE id = 'tool:dup'");
                expect(got.rows[0]!["name"]).toBe("second");
            }),
        );
    });

    dtest("a later flush upserts over an earlier one, like back-to-back putMany", async () => {
        const dir = tempDir("spool-upsert");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("tool", [{ id: "tool:u", name: "before", provider: "claude" }]);
                yield* spool.flush(write);
                spool.append("tool", [{ id: "tool:u", name: "after", provider: "claude" }]);
                yield* spool.flush(write);
                const got = yield* write.raw("SELECT count(*) AS n, min(name) AS name FROM tool WHERE id = 'tool:u'");
                expect(got.rows[0]!["n"]).toBe(1n);
                expect(got.rows[0]!["name"]).toBe("after");
            }),
        );
    });

    dtest("a NARROWER signature cannot NULL a column it never carried", async () => {
        const dir = tempDir("spool-ragged");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("file", [{ id: "file:1", path: "/a.ts", lang: "ts" }]);
                yield* spool.flush(write);
                // The narrow update (no `lang`) goes to its own signature group
                // and its ON CONFLICT SET list does not name `lang`.
                spool.append("file", [{ id: "file:1", path: "/a-moved.ts" }]);
                yield* spool.flush(write);
                const got = yield* write.raw("SELECT path, lang FROM file WHERE id = 'file:1'");
                expect(got.rows[0]!["path"]).toBe("/a-moved.ts");
                expect(got.rows[0]!["lang"]).toBe("ts");
            }),
        );
    });

    dtest("two signatures in one window load as separate statements", async () => {
        const dir = tempDir("spool-sig");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("file", [{ id: "file:wide", path: "/w.ts", lang: "ts" }]);
                spool.append("file", [{ id: "file:narrow", path: "/n.ts" }]);
                const outcome = yield* spool.flush(write);
                expect(outcome.rows).toBe(2);
                expect(outcome.statements).toBe(2);
                const got = yield* write.raw("SELECT count(*) AS n FROM file");
                expect(got.rows[0]!["n"]).toBe(2n);
            }),
        );
    });

    dtest("strips U+0000 from text values and counts what it scrubbed", async () => {
        const dir = tempDir("spool-nul");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("tool", [{ id: "tool:nul", name: "bad\u0000name", provider: "claude" }]);
                yield* spool.flush(write);
                expect(spool.totals().nulValues).toBe(1);
                const got = yield* write.raw("SELECT name FROM tool WHERE id = 'tool:nul'");
                expect(got.rows[0]!["name"]).toBe("badname");
            }),
        );
    });

    dtest("flush unlinks its spool files", async () => {
        const dir = tempDir("spool-unlink");
        await asIngestRun(dir, (write, spool, spoolDir) =>
            Effect.gen(function* () {
                spool.append("tool", [{ id: "tool:f", name: "x", provider: "claude" }]);
                yield* spool.flush(write);
                const left = yield* Effect.promise(() =>
                    Array.fromAsync(new Bun.Glob("*").scan({ cwd: spoolDir })),
                );
                expect(left).toEqual([]);
            }),
        );
    });

    test("refuses a row whose column the DDL does not declare", () => {
        const spool = makeTableSpool({ tables: ["tool"], dir: "/nonexistent" });
        expect(() => spool.append("tool", [{ id: "t", nonsense: "x" }])).toThrow(/does not declare/);
    });

    test("refuses a non-string id and a missing id", () => {
        const spool = makeTableSpool({ tables: ["invoked"], dir: "/nonexistent" });
        expect(() => spool.append("invoked", [{ id: 5, in_id: "a", out_id: "b" }])).toThrow(/non-string id/);
        expect(() => spool.append("invoked", [{ in_id: "a", out_id: "b" }])).toThrow(/`id`/);
    });

    test("refuses a ragged batch within one append, like putMany", () => {
        const spool = makeTableSpool({ tables: ["tool"], dir: "/nonexistent" });
        expect(() =>
            spool.append("tool", [
                { id: "a", name: "x" },
                { id: "b", name: "y", provider: "claude" },
            ]),
        ).toThrow(/ragged/);
    });

    test("refuses a table missing from the allowlist and an unknown table", () => {
        const spool = makeTableSpool({ tables: ["tool"], dir: "/nonexistent" });
        expect(() => spool.append("turn", [{ id: "t" }])).toThrow(/allowlist/);
        expect(() => makeTableSpool({ tables: ["no_such_table"], dir: "/nonexistent" })).toThrow(
            /no columns found/,
        );
    });

    test("refuses a bigint outside int64, like the bind path", () => {
        const spool = makeTableSpool({ tables: ["turn_token_usage"], dir: "/nonexistent" });
        expect(() =>
            spool.append("turn_token_usage", [
                {
                    id: "ttu:big",
                    session: "s",
                    turn: "t",
                    seq: 1,
                    source: "x",
                    prompt_tokens: 2n ** 64n,
                    estimated_tokens: 0,
                    usage_source: "u",
                    usage_quality: "q",
                },
            ]),
        ).toThrow(/64-bit/);
    });
});

describe("withTableSpool", () => {
    dtest("routes spooled tables to the buffer and everything else straight through", async () => {
        const dir = tempDir("spool-decorator");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const spooled = withTableSpool(write, spool);
                yield* spooled.put("tool", { id: "tool:s", name: "Read" });
                // `session` is not in this spool's table set: it writes NOW.
                yield* spooled.put("session", {
                    id: "sess:1",
                    source: "claude",
                    started_at: new Date("2026-08-18T00:00:00Z"),
                });
                const mid = yield* write.raw(
                    "SELECT (SELECT count(*) FROM tool) AS tools, (SELECT count(*) FROM session) AS sessions",
                );
                expect(mid.rows[0]!["tools"]).toBe(0n);
                expect(mid.rows[0]!["sessions"]).toBe(1n);

                // exec passes through immediately - the delete-before-flush
                // ordering the agent_event writers rely on.
                yield* spooled.exec("DELETE FROM session WHERE id = ?", ["sess:1"]);
                yield* spool.flush(write);
                const end = yield* write.raw(
                    "SELECT (SELECT count(*) FROM tool) AS tools, (SELECT count(*) FROM session) AS sessions",
                );
                expect(end.rows[0]!["tools"]).toBe(1n);
                expect(end.rows[0]!["sessions"]).toBe(0n);
            }),
        );
    });
});
