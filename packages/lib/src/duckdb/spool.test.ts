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
import { Cause, Deferred, Effect, Fiber, FileSystem, Path } from "effect";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "../ingest-lock.ts";
import { runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { withCacheWrite, type CacheWriteService } from "./seam.ts";
import { DuckDbQueryError } from "./errors.ts";
import { makeTableSpool, withTableSpool, type TableSpool, type TableSpoolOptions } from "./spool.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache spool");

/** One ingest "run" against a live database in `dir` - lock held, schema
 *  applied - mirroring watermark.test.ts. */
const asIngestRun = <A>(
    dir: string,
    body: (write: CacheWriteService, spool: TableSpool, spoolDir: string) => Effect.Effect<A, unknown, never>,
    options: Pick<TableSpoolOptions, "limits"> = {},
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
                            ...options,
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
    dtest("bounded putMany flushes inside one input and records exact UTF-8 peaks", async () => {
        const dir = tempDir("spool-bounded");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const spooled = withTableSpool(write, spool);
                yield* spooled.putMany("tool", [
                    { id: "tool:one", name: "a", provider: "codex" },
                    { id: "tool:two", name: "漢字", provider: "codex" },
                    { id: "tool:three", name: "c", provider: "codex" },
                    { id: "tool:four", name: "d", provider: "codex" },
                    { id: "tool:five", name: "e", provider: "codex" },
                ]);

                const visible = yield* write.raw("SELECT count(*) AS n FROM tool");
                expect(visible.rows[0]!["n"]).toBeGreaterThan(0n);
                expect(spool.totals().peakPendingRows).toBeLessThanOrEqual(2);
                expect(spool.totals().peakPendingBytes).toBeGreaterThan(0);
                yield* spool.flush(write);
                const stored = yield* write.raw("SELECT id, name FROM tool ORDER BY id");
                expect(stored.rows).toHaveLength(5);
                expect(stored.rows.find((row) => row["id"] === "tool:two")?.["name"]).toBe("漢字");
            }),
        { limits: { maxRows: 2, maxBytes: 1_000 } });
    });

    dtest("bounded replacements update byte accounting and keep the last value", async () => {
        const dir = tempDir("spool-bounded-replace");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const spooled = withTableSpool(write, spool);
                yield* spooled.put("tool", { id: "tool:r", name: "a", provider: "codex" });
                const small = spool.pendingBytes();
                expect(small).toBe(new TextEncoder().encode(
                    `${JSON.stringify({ id: "tool:r", name: "a", provider: "codex" })}\n`,
                ).byteLength);
                yield* spooled.put("tool", { id: "tool:r", name: "a much larger value", provider: "codex" });
                const large = spool.pendingBytes();
                expect(large).toBe(new TextEncoder().encode(
                    `${JSON.stringify({ id: "tool:r", name: "a much larger value", provider: "codex" })}\n`,
                ).byteLength);
                yield* spooled.put("tool", { id: "tool:r", name: "x", provider: "codex" });
                expect(spool.pendingRows()).toBe(1);
                expect(large).toBeGreaterThan(small);
                expect(spool.pendingBytes()).toBeLessThan(large);
                yield* spool.flush(write);
                expect(spool.totals().automaticFlushes).toBe(0);
                const stored = yield* write.raw("SELECT name FROM tool WHERE id = 'tool:r'");
                expect(stored.rows[0]!["name"]).toBe("x");
            }),
        { limits: { maxRows: 100, maxBytes: 10_000 } });
    });

    dtest("the byte limit flushes regular rows within one putMany", async () => {
        const dir = tempDir("spool-bounded-bytes");
        const rows = [
            { id: "tool:byte-1", name: "alpha", provider: "codex" },
            { id: "tool:byte-2", name: "bravo", provider: "codex" },
            { id: "tool:byte-3", name: "charlie", provider: "codex" },
            { id: "tool:byte-4", name: "delta", provider: "codex" },
        ];
        const encodedBytes = rows.map((row) => new TextEncoder().encode(`${JSON.stringify(row)}\n`).byteLength);
        const maxBytes = encodedBytes[0]! + 1;
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                yield* withTableSpool(write, spool).putMany("tool", rows);
                const totals = spool.totals();
                expect(totals.peakPendingRows).toBeGreaterThan(1);
                expect(totals.peakPendingBytes).toBeGreaterThan(maxBytes);
                expect(totals.peakPendingBytes).toBeLessThanOrEqual(maxBytes + Math.max(...encodedBytes));
                expect(totals.automaticFlushes).toBeGreaterThan(0);
                const visible = yield* write.raw("SELECT count(*) AS n FROM tool");
                expect(visible.rows[0]!["n"]).toBeGreaterThan(0n);
                yield* spool.flush(write);
                const stored = yield* write.raw("SELECT count(*) AS n FROM tool");
                expect(stored.rows[0]!["n"]).toBe(4n);
            }),
        { limits: { maxRows: 100, maxBytes } });
    });

    dtest("one oversized row stays complete and flushes immediately", async () => {
        const dir = tempDir("spool-bounded-oversized");
        const value = "🚀".repeat(100);
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                yield* withTableSpool(write, spool).put("tool", { id: "tool:large", name: value, provider: "codex" });
                expect(spool.pendingRows()).toBe(0);
                expect(spool.totals().peakPendingBytes).toBeGreaterThan(32);
                const stored = yield* write.raw("SELECT name FROM tool WHERE id = 'tool:large'");
                expect(stored.rows[0]!["name"]).toBe(value);
            }),
        { limits: { maxRows: 100, maxBytes: 32 } });
    });

    dtest("a large invalid batch is fully validated before any bounded prefix loads", async () => {
        const dir = tempDir("spool-bounded-invalid");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const outcome = yield* withTableSpool(write, spool).putMany("tool", [
                    { id: "tool:valid", name: "valid" },
                    { id: "tool:ragged", name: "invalid", provider: "codex" },
                ]).pipe(Effect.exit);
                expect(outcome._tag).toBe("Failure");
                expect(spool.pendingRows()).toBe(0);
                const stored = yield* write.raw("SELECT count(*) AS n FROM tool");
                expect(stored.rows[0]!["n"]).toBe(0n);
            }),
        { limits: { maxRows: 1, maxBytes: 10_000 } });
    });

    dtest("concurrent bounded writes wait for one automatic flush", async () => {
        const dir = tempDir("spool-bounded-concurrent");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const entered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let execs = 0;
                const blockedWrite: CacheWriteService = {
                    ...write,
                    exec: (sql, params) => Effect.gen(function* () {
                        execs += 1;
                        if (execs === 1) {
                            yield* Deferred.succeed(entered, undefined);
                            yield* Deferred.await(release);
                        }
                        return yield* write.exec(sql, params);
                    }),
                };
                const spooled = withTableSpool(blockedWrite, spool);
                const first = yield* spooled.put("tool", { id: "tool:a", name: "a" }).pipe(Effect.forkChild);
                yield* Deferred.await(entered);
                const explicit = yield* spool.flush(blockedWrite).pipe(Effect.forkChild);
                const second = yield* spooled.put("tool", { id: "tool:b", name: "b" }).pipe(Effect.forkChild);
                yield* Effect.yieldNow;
                expect(spool.totals().peakPendingRows).toBe(1);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(first);
                yield* Fiber.join(explicit);
                yield* Fiber.join(second);
                yield* spool.flush(blockedWrite);
                const stored = yield* write.raw("SELECT id FROM tool ORDER BY id");
                expect(stored.rows.map((row) => row["id"])).toEqual(["tool:a", "tool:b"]);
            }),
        { limits: { maxRows: 1, maxBytes: 10_000 } });
    });

    dtest("a queued health check observes the first flush failure", async () => {
        const dir = tempDir("spool-bounded-health");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const entered = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const failure = new DuckDbQueryError({ sql: "forced", message: "forced flush failure" });
                const failedWrite: CacheWriteService = {
                    ...write,
                    exec: () => Effect.gen(function* () {
                        yield* Deferred.succeed(entered, undefined);
                        yield* Deferred.await(release);
                        return yield* Effect.fail(failure);
                    }),
                };
                const first = yield* withTableSpool(failedWrite, spool)
                    .put("tool", { id: "tool:fail", name: "x" })
                    .pipe(Effect.exit, Effect.forkChild);
                yield* Deferred.await(entered);
                const health = yield* spool.assertHealthy().pipe(Effect.exit, Effect.forkChild);
                yield* Effect.yieldNow;
                yield* Deferred.succeed(release, undefined);
                const firstExit = yield* Fiber.join(first);
                const healthExit = yield* Fiber.join(health);
                expect(firstExit._tag).toBe("Failure");
                expect(healthExit._tag).toBe("Failure");
                if (firstExit._tag === "Failure" && healthExit._tag === "Failure") {
                    expect(Cause.pretty(healthExit.cause)).toContain("forced flush failure");
                    expect(Cause.pretty(healthExit.cause)).toBe(Cause.pretty(firstExit.cause));
                }
            }),
        { limits: { maxRows: 1, maxBytes: 10_000 } });
    });

    dtest("an interrupted flush stores its cause and releases the gate", async () => {
        const dir = tempDir("spool-bounded-interrupt");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                const entered = yield* Deferred.make<void>();
                const blockedWrite: CacheWriteService = {
                    ...write,
                    exec: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                };
                const flush = yield* withTableSpool(blockedWrite, spool)
                    .put("tool", { id: "tool:interrupt", name: "x" })
                    .pipe(Effect.forkChild);
                yield* Deferred.await(entered);
                yield* Fiber.interrupt(flush);
                const health = yield* spool.assertHealthy().pipe(Effect.exit);
                expect(health._tag).toBe("Failure");
                if (health._tag === "Failure") expect(Cause.hasInterrupts(health.cause)).toBe(true);
            }),
        { limits: { maxRows: 1, maxBytes: 10_000 } });
    });

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
                expect(spool.totals().automaticFlushes).toBe(0);
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

    dtest("same id twice in ONE window dedups last-wins", async () => {
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

    dtest("repairs an unpaired UTF-16 surrogate instead of failing the whole load (#906)", async () => {
        const dir = tempDir("spool-surrogate");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                // A truncated emoji: a lone high surrogate. JSON.stringify
                // emits it as a bare \ud83d escape, which read_ndjson rejects
                // as "no low surrogate" - killing the batch on a cold backfill.
                spool.append("tool", [{ id: "tool:surrogate", name: "cut\uD83Dend", provider: "codex" }]);
                yield* spool.flush(write);
                expect(spool.totals().illFormedValues).toBe(1);
                const got = yield* write.raw("SELECT name FROM tool WHERE id = 'tool:surrogate'");
                // The lone half became U+FFFD; the rest of the value is intact.
                expect(got.rows[0]!["name"]).toBe("cut�end");
            }),
        );
    });

    dtest("deduplicates on the encoded id with last occurrence wins (#951)", async () => {
        const dir = tempDir("spool-encoded-id-dedup");
        await asIngestRun(dir, (write, spool) =>
            Effect.gen(function* () {
                spool.append("tool", [
                    { id: "k\uD800", name: "first", provider: "codex" },
                    { id: "k\uDC00", name: "second", provider: "codex" },
                ]);
                expect(spool.pendingRows()).toBe(1);
                const outcome = yield* spool.flush(write);
                expect(outcome.rows).toBe(1);
                const got = yield* write.raw("SELECT id, name FROM tool");
                expect(got.rows).toEqual([{ id: "k�", name: "second" }]);
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

    test("refuses nonpositive and nonfinite limits", () => {
        for (const limits of [
            { maxRows: 0, maxBytes: 1 },
            { maxRows: 1, maxBytes: 0 },
            { maxRows: Number.POSITIVE_INFINITY, maxBytes: 1 },
            { maxRows: 1, maxBytes: Number.NaN },
        ]) {
            expect(() => makeTableSpool({ tables: ["tool"], dir: "/nonexistent", limits })).toThrow(/limit/);
        }
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
