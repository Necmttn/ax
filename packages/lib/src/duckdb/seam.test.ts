/**
 * The seam, against a REAL DuckDB. Nothing here is mocked: every case opens a
 * real database file in a real temp directory, through the real dylib.
 */
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeLockPayload, withIngestLock } from "../ingest-lock.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { TimestampColumn } from "./columns.ts";
import { buildFtsIndexes, matchBm25Sql, type FtsTarget } from "./fts.ts";
import { NUL } from "./nul-strip.ts";
import {
    CacheRead,
    CacheReadLayer,
    WRITE_STAMPED_COLUMNS,
    withCacheWrite,
    type CacheWriteService,
} from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("duckdb seam", { requireFts: true });

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

/** The dylib every case injects, so the seam resolves the same build the suite did. */
const dylibEnv = <A>(body: () => Promise<A>): Promise<A> => {
    const previous = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
    return body().finally(() => {
        if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
        else process.env.AX_DUCKDB_DYLIB = previous;
    });
};

const DDL = `
CREATE TABLE IF NOT EXISTS skill (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS turn (
    id VARCHAR PRIMARY KEY,
    text_excerpt VARCHAR,
    ts TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS note (
    id VARCHAR PRIMARY KEY,
    body VARCHAR,
    ingested_at TIMESTAMP
);
-- A DDL DEFAULT CURRENT_TIMESTAMP column nothing stamps, so the value comes
-- from the DATABASE's clock alone - the shape the UTC contract stands or falls on.
CREATE TABLE IF NOT EXISTS defaulted (
    id VARCHAR PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A table with a SECOND unique constraint on top of its primary key, which most
-- of the real schema has (turn_session_seq, commit_sha_uq, skill_name_uq, ...).
-- Upserting into one of these is what INSERT OR REPLACE cannot do.
CREATE TABLE IF NOT EXISTS keyed (
    id VARCHAR PRIMARY KEY,
    natural_a VARCHAR NOT NULL,
    natural_b BIGINT NOT NULL,
    body VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS keyed_natural_uq ON keyed(natural_a, natural_b);
`;

/** A live db + lock + snapshot triple in a fresh temp dir. */
const paths = (prefix: string) => {
    const dir = tempDir(prefix);
    return {
        dir,
        livePath: join(dir, "live.duckdb"),
        lockPath: join(dir, "ingest.lock"),
        snapshotPath: join(dir, "snapshot.duckdb"),
    };
};

/** Run `body` with write access, holding the ingest lock exactly as ingest does. */
const asIngest = <A, E>(
    p: ReturnType<typeof paths>,
    body: (write: CacheWriteService) => Effect.Effect<A, E, never>,
) =>
    withIngestLock(
        {
            lockPath: p.lockPath,
            command: "seam-test",
            staleMs: 60_000,
            onBusy: () => Effect.succeed("busy" as const),
        },
        withCacheWrite(
            { livePath: p.livePath, lockPath: p.lockPath, snapshotPath: p.snapshotPath, schemaSql: DDL },
            body,
        ),
    );

const SkillRow = Schema.Struct({ id: Schema.String, name: Schema.String, ingested_at: TimestampColumn });

describe("CacheWrite: the ingest lock IS the write capability", () => {
    dtest("refuses to open the live database when the lock is not held, naming both paths", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-unlocked-");
            const exit = await Effect.runPromiseExit(
                withCacheWrite(
                    { livePath: p.livePath, lockPath: p.lockPath, schemaSql: DDL },
                    () => Effect.succeed("should not run"),
                ).pipe(Effect.provide(Platform)) as Effect.Effect<string, unknown>,
            );

            expect(exit._tag).toBe("Failure");
            const message = JSON.stringify(exit);
            expect(message).toContain("CacheWriteUnlockedError");
            expect(message).toContain(p.livePath);
            expect(message).toContain(p.lockPath);
            // Nothing was created: the refusal happens BEFORE any open.
            expect(existsSync(p.livePath)).toBe(false);
        });
    });

    dtest("refuses when another process has taken the lock over mid-run", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-stolen-");
            // Hold the lock, then let someone else replace the lock file - the
            // shape a stale-lock takeover leaves on disk. Our in-process registry
            // still names us, so only reading the FILE can tell us we lost it.
            const exit = await Effect.runPromiseExit(
                withIngestLock(
                    {
                        lockPath: p.lockPath,
                        command: "seam-test",
                        staleMs: 60_000,
                        onBusy: () => Effect.succeed("busy" as const),
                    },
                    Effect.gen(function* () {
                        writeFileSync(
                            p.lockPath,
                            encodeLockPayload({
                                pid: process.pid,
                                startedAt: Date.now(),
                                command: "the other ingest",
                                token: "a-token-we-never-minted",
                            }),
                        );
                        return yield* withCacheWrite(
                            {
                                livePath: p.livePath,
                                lockPath: p.lockPath,
                                snapshotPath: p.snapshotPath,
                                schemaSql: DDL,
                            },
                            (write) => write.put("skill", { id: "s1", name: "should not land" }),
                        );
                    }),
                ).pipe(Effect.provide(Platform)) as Effect.Effect<unknown, unknown>,
            );

            expect(exit._tag).toBe("Failure");
            expect(JSON.stringify(exit)).toContain("CacheWriteUnlockedError");
            // The refusal happens BEFORE any open, so nothing was created.
            expect(existsSync(p.livePath)).toBe(false);
        });
    });

    dtest("opens, applies the DDL and writes when the lock IS held", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-locked-");
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s1", name: "tdd" });
                        return yield* write.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    }),
                ),
            );

            expect(outcome._tag).toBe("completed");
            const rows = outcome._tag === "completed" ? outcome.value : [];
            expect(rows).toHaveLength(1);
            expect(rows[0]?.name).toBe("tdd");
        });
    });
});

describe("CacheWrite: the semantics the DDL cannot express", () => {
    dtest("stamps skill.ingested_at even when the caller supplies its own value", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-stamp-");
            const ancient = new Date("1999-01-01T00:00:00.000Z");
            const before = Date.now();

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s1", name: "tdd", ingested_at: ancient });
                        return yield* write.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    }),
                ),
            );

            const rows = outcome._tag === "completed" ? outcome.value : [];
            const stamped = rows[0]?.ingested_at;
            expect(stamped).toBeInstanceOf(Date);
            // The caller's value was DROPPED, and the database's clock used.
            expect(stamped?.getTime()).toBeGreaterThanOrEqual(before - 1000);
            expect(stamped?.getTime()).not.toBe(ancient.getTime());
        });
    });

    dtest("does NOT stamp a table outside WRITE_STAMPED_COLUMNS", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-nostamp-");
            const ancient = new Date("1999-01-01T00:00:00.000Z");
            expect(WRITE_STAMPED_COLUMNS["note"]).toBeUndefined();

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("note", { id: "n1", body: "hi", ingested_at: ancient });
                        return yield* write.rows(
                            Schema.Struct({ ingested_at: TimestampColumn }),
                            "SELECT ingested_at FROM note",
                        );
                    }),
                ),
            );

            const rows = outcome._tag === "completed" ? outcome.value : [];
            // `note` is an ordinary table: the caller's value is honoured.
            expect(rows[0]?.ingested_at.toISOString()).toBe(ancient.toISOString());
        });
    });

    dtest("putMany batches rows of one shape and refuses a ragged batch", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-putmany-");
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.putMany("note", []); // no-op, no statement issued
                        yield* write.putMany(
                            "note",
                            Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, body: `body ${i}` })),
                        );
                        const counted = yield* write.rows(
                            Schema.Struct({ n: Schema.BigInt }),
                            "SELECT count(*) AS n FROM note",
                        );
                        const ragged = yield* Effect.result(
                            write.putMany("note", [{ id: "a", body: "x" }, { id: "b" }]),
                        );
                        return { count: counted[0]?.n, ragged };
                    }),
                ),
            );

            const value = outcome._tag === "completed" ? outcome.value : null;
            // 600 rows crosses the 500-row batch boundary.
            expect(value?.count).toBe(600n);
            expect(value?.ragged._tag).toBe("Failure");
        });
    });

    /**
     * #790, the half wave 2 shipped without. The client REFUSES to bind a
     * VARCHAR carrying U+0000 (it would truncate silently at the first NUL and
     * the length-less read accessor could never tell), and real transcripts
     * carry them - so an unrestricted `ax ingest` died on
     * `INSERT INTO "turn" - parameter 6743 contains a NUL byte`. The write seam
     * now scrubs on the way in. Without that scrub every case below fails with
     * that exact refusal.
     */
    dtest("strips NUL bytes out of every bound write value, and counts what it stripped", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-nul-");
            // A genuine U+0000 in the middle of otherwise ordinary text - the
            // shape a JSON transcript's "\\u0000" decodes to.
            const dirty = `before${NUL}after`;

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("note", { id: "n1", body: dirty });
                        // putMany's batched multi-row insert binds through the
                        // same choke point...
                        yield* write.putMany("note", [
                            { id: "n2", body: `two${NUL}` },
                            { id: "n3", body: "clean" },
                        ]);
                        // ...and so does a hand-written statement.
                        yield* write.exec("UPDATE note SET body = ? WHERE id = ?", [
                            `${NUL}lead${NUL}`,
                            "n3",
                        ]);

                        const rows = yield* write.rows(
                            Schema.Struct({
                                id: Schema.String,
                                body: Schema.String,
                                len: Schema.BigInt,
                            }),
                            "SELECT id, body, length(body) AS len FROM note ORDER BY id",
                        );
                        return { rows, stripped: write.nulStripped() };
                    }),
                ),
            );

            expect(outcome._tag).toBe("completed");
            const value = outcome._tag === "completed" ? outcome.value : null;

            // Stored text is the NUL-free text - NOT truncated at the first NUL
            // (which is what an unguarded bind would have stored), and NOT an
            // escape sequence no source ever contained. `length` is read by
            // DuckDB itself, so it proves what is IN the column rather than what
            // the CString accessor could render.
            expect(value?.rows).toEqual([
                { id: "n1", body: "beforeafter", len: 11n },
                { id: "n2", body: "two", len: 3n },
                { id: "n3", body: "lead", len: 4n },
            ]);

            // Observable, not silent: three dirty values across three
            // statements. `putMany` bound two rows and only ONE of them was
            // dirty, so the clean row and every `id` parameter go uncounted -
            // the number is "values we changed", not "values we looked at".
            expect(value?.stripped).toEqual({ values: 3, statements: 3 });
        });
    });

    dtest("a write with no NUL anywhere reports nothing stripped", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-nul-clean-");
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        // The six characters a transcript literally spells are
                        // TEXT, and must survive byte-for-byte.
                        yield* write.put("note", { id: "n1", body: "escaped \\u0000 stays" });
                        const rows = yield* write.rows(
                            Schema.Struct({ body: Schema.String }),
                            "SELECT body FROM note",
                        );
                        return { rows, stripped: write.nulStripped() };
                    }),
                ),
            );

            const value = outcome._tag === "completed" ? outcome.value : null;
            expect(value?.rows[0]?.body).toBe("escaped \\u0000 stays");
            expect(value?.stripped).toEqual({ values: 0, statements: 0 });
        });
    });

    dtest("upserts into a table that has a SECOND unique constraint", async () => {
        // `INSERT OR REPLACE` - the obvious spelling, and what this seam shipped
        // with - fails on every such table with "Conflict target has to be
        // provided for a DO UPDATE operation". Most of the real schema is such a
        // table, so the whole write path was unusable beyond the simplest ones.
        await dylibEnv(async () => {
            const p = paths("ax-seam-multiuq-");
            const Keyed = Schema.Struct({ id: Schema.String, body: Schema.NullOr(Schema.String) });
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("keyed", { id: "k1", natural_a: "a", natural_b: 1, body: "first" });
                        // Same id: a re-ingest REPLACES the row.
                        yield* write.put("keyed", { id: "k1", natural_a: "a", natural_b: 1, body: "second" });
                        const rows = yield* write.rows(Keyed, "SELECT id, body FROM keyed");
                        // Different id, SAME natural key: a constraint violation
                        // the caller must see, not a silent overwrite of k1.
                        const collision = yield* Effect.result(
                            write.put("keyed", { id: "k2", natural_a: "a", natural_b: 1, body: "impostor" }),
                        );
                        return { rows, collision: collision._tag };
                    }),
                ),
            );

            const value = outcome._tag === "completed" ? outcome.value : null;
            expect(value?.rows).toEqual([{ id: "k1", body: "second" }]);
            expect(value?.collision).toBe("Failure");
        });
    });

    dtest("refuses a row with no id, naming the schema-wide key invariant", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-noid-");
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        const result = yield* Effect.result(write.put("note", { body: "orphan" }));
                        const counted = yield* write.rows(
                            Schema.Struct({ n: Schema.BigInt }),
                            "SELECT count(*) AS n FROM note",
                        );
                        return { result, n: counted[0]?.n };
                    }),
                ),
            );

            const value = outcome._tag === "completed" ? outcome.value : null;
            expect(value?.result._tag).toBe("Failure");
            expect(JSON.stringify(value?.result)).toContain("needs an `id` on every row");
            expect(value?.n).toBe(0n);
        });
    });

    dtest("refuses an unsafe table or column name instead of interpolating it", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-inject-");
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        const badTable = yield* Effect.result(write.put('note"; DROP TABLE note; --', { id: "x" }));
                        const badColumn = yield* Effect.result(write.put("note", { 'id"; --': "x" }));
                        const stillThere = yield* write.rows(
                            Schema.Struct({ n: Schema.BigInt }),
                            "SELECT count(*) AS n FROM note",
                        );
                        return { badTable: badTable._tag, badColumn: badColumn._tag, n: stillThere[0]?.n };
                    }),
                ),
            );

            const value = outcome._tag === "completed" ? outcome.value : null;
            expect(value?.badTable).toBe("Failure");
            expect(value?.badColumn).toBe("Failure");
            expect(value?.n).toBe(0n);
        });
    });
});

describe("CacheWrite: publish", () => {
    dtest("publishes the snapshot on success", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-publish-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "published" })));
            expect(existsSync(p.snapshotPath)).toBe(true);

            const found = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
            expect(found[0]?.name).toBe("published");
        });
    });

    dtest("does NOT publish when the body fails - the previous snapshot survives byte-identical", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-nopublish-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "good" })));
            const before = readFileSync(p.snapshotPath);

            const exit = await Effect.runPromiseExit(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s2", name: "doomed" });
                        return yield* Effect.fail("ingest blew up" as const);
                    }),
                ).pipe(Effect.provide(Platform)) as Effect.Effect<unknown, unknown>,
            );

            expect(exit._tag).toBe("Failure");
            expect(readFileSync(p.snapshotPath).equals(before)).toBe(true);

            // And the published snapshot still contains only the good row.
            const found = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill ORDER BY id");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
            expect(found.map((r) => r.name)).toEqual(["good"]);
        });
    });

    /**
     * THE REGRESSION. "Publish only on success" is gated on `body` succeeding,
     * which means "the ingest succeeded" only while ingest is the sole caller of
     * this seam. It is not - the CLI stamps the `ingest_run` row from `onTimeout`
     * and GCs blobs from `afterWork`, each through its own `withCacheWrite`, and
     * each body is a one-statement write that succeeds no matter how the ingest
     * it reports on ended.
     *
     * Before `publish: false` this sequence published the timed-out run's PARTIAL
     * database over a good snapshot: the failing ingest correctly withheld its
     * publish, and the maintenance write that followed handed the half-written
     * rows to every reader anyway. Ingest runs in no transaction, so the partial
     * rows are committed and there is nothing to roll back.
     */
    dtest("a maintenance write does NOT publish the partial database a failed ingest left behind", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-maintenance-");

            // A good ingest publishes a good snapshot.
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "good" })));
            const goodSnapshot = readFileSync(p.snapshotPath);

            // The real ingest writes rows, then times out. No publish - verified
            // by the case above, and re-asserted here so the sequence is honest.
            const failed = await Effect.runPromiseExit(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s2", name: "half-written" });
                        return yield* Effect.fail("ingest timed out" as const);
                    }),
                ).pipe(Effect.provide(Platform)) as Effect.Effect<unknown, unknown>,
            );
            expect(failed._tag).toBe("Failure");
            expect(readFileSync(p.snapshotPath).equals(goodSnapshot)).toBe(true);

            // The onTimeout shape: a separate, SUCCEEDING maintenance write.
            await run(
                withIngestLock(
                    {
                        lockPath: p.lockPath,
                        command: "seam-test-maintenance",
                        staleMs: 60_000,
                        onBusy: () => Effect.succeed("busy" as const),
                    },
                    withCacheWrite(
                        {
                            livePath: p.livePath,
                            lockPath: p.lockPath,
                            snapshotPath: p.snapshotPath,
                            schemaSql: DDL,
                            publish: false,
                        },
                        (write) => write.put("note", { id: "run-1", body: "status=partial" }),
                    ),
                ),
            );

            // The snapshot is still byte-identical to the good one, and the
            // half-written row never became readable.
            expect(readFileSync(p.snapshotPath).equals(goodSnapshot)).toBe(true);
            const found = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill ORDER BY id");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
            expect(found.map((r) => r.name)).toEqual(["good"]);
        });
    });

    dtest("the maintenance write still lands in the LIVE database it opted out of publishing", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-maintenance-live-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "good" })));

            await run(
                withIngestLock(
                    {
                        lockPath: p.lockPath,
                        command: "seam-test-maintenance",
                        staleMs: 60_000,
                        onBusy: () => Effect.succeed("busy" as const),
                    },
                    withCacheWrite(
                        {
                            livePath: p.livePath,
                            lockPath: p.lockPath,
                            snapshotPath: p.snapshotPath,
                            schemaSql: DDL,
                            publish: false,
                        },
                        (write) => write.put("note", { id: "run-1", body: "status=partial" }),
                    ),
                ),
            );

            // Opting out of publishing must not be mistaken for opting out of
            // writing: the next ingest publishes this row along with its own.
            const outcome = await run(
                asIngest(p, (write) =>
                    write.rows(
                        Schema.Struct({ id: Schema.String, body: Schema.NullOr(Schema.String) }),
                        "SELECT id, body FROM note ORDER BY id",
                    ),
                ),
            );
            expect(outcome).toEqual({
                _tag: "completed",
                value: [{ id: "run-1", body: "status=partial" }],
            });
        });
    });
});

describe("CacheRead", () => {
    dtest("builds and tears down without opening anything when no query runs", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-lazy-");
            // No snapshot exists at all. Building and releasing the layer must
            // still succeed - this is the `ax studio` / `ax mcp` startup shape.
            await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    expect(read.snapshotPath).toBe(p.snapshotPath);
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
        });
    });

    dtest("a missing snapshot fails with an error that names the path and the fix", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-missing-");
            const exit = await Effect.runPromiseExit(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.raw("SELECT 1");
                }).pipe(
                    Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath })),
                ) as Effect.Effect<unknown, unknown>,
            );

            expect(exit._tag).toBe("Failure");
            const message = JSON.stringify(exit);
            expect(message).toContain("CacheUnavailableError");
            expect(message).toContain(p.snapshotPath);
            expect(message).toContain("ax ingest");
        });
    });

    dtest("picks the snapshot up after it appears - a failure is not memoized", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-retry-");
            await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;

                    // Query BEFORE any ingest: fails.
                    const early = yield* Effect.result(read.raw("SELECT count(*) AS n FROM skill"));
                    expect(early._tag).toBe("Failure");

                    // Ingest publishes a snapshot...
                    yield* asIngest(p, (write) => write.put("skill", { id: "s1", name: "late" }));

                    // ...and the SAME long-lived reader now sees it.
                    const late = yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    expect(late[0]?.name).toBe("late");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
        });
    });

    dtest("first returns none on an empty result and some on a hit", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-first-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "only" })));

            const [empty, hit] = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    const none = yield* read.first(SkillRow, "SELECT id, name, ingested_at FROM skill WHERE id = ?", [
                        "nope",
                    ]);
                    const some = yield* read.first(SkillRow, "SELECT id, name, ingested_at FROM skill WHERE id = ?", [
                        "s1",
                    ]);
                    return [none, some] as const;
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );

            expect(Option.isNone(empty)).toBe(true);
            expect(Option.isSome(hit) && hit.value.name).toBe("only");
        });
    });

    /**
     * The long-lived-reader case, and the reason the memoized connection cannot
     * simply be kept: `ax studio` and `ax mcp` hold ONE `CacheRead` for the whole
     * process lifetime. A publish renames a NEW file over the snapshot path, so a
     * reader that keeps its first handle keeps reading the old inode - every
     * request after the first ingest answered stale data until the process
     * restarted. The reader must notice the swap and reopen.
     */
    dtest("a long-lived reader observes a republished snapshot", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-republish-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "first" })));

            await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    const initial = yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    expect(initial.map((r) => r.name)).toEqual(["first"]);

                    // Republish with an extra row - an atomic rename over the path.
                    yield* asIngest(p, (write) => write.put("skill", { id: "s2", name: "second" }));

                    // The SAME reader picks the new snapshot up.
                    const after = yield* read.rows(
                        SkillRow,
                        "SELECT id, name, ingested_at FROM skill ORDER BY id",
                    );
                    expect(after.map((r) => r.name)).toEqual(["first", "second"]);

                    // And a third publish is observed too, so this is not a
                    // one-shot "reopen once" that then goes stale again.
                    yield* asIngest(p, (write) => write.put("skill", { id: "s3", name: "third" }));
                    const third = yield* read.rows(
                        SkillRow,
                        "SELECT id, name, ingested_at FROM skill ORDER BY id",
                    );
                    expect(third.map((r) => r.name)).toEqual(["first", "second", "third"]);
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
        });
    });

    dtest("many concurrent queries across a publish all answer, none on a closed handle", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-concurrent-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "first" })));

            const names = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    const query = read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill ORDER BY id");
                    // Reads racing the republish. Every one must succeed: the
                    // retiring handle may not be closed while a query holds it.
                    const [before, _publish, after] = yield* Effect.all(
                        [
                            Effect.all(Array.from({ length: 8 }, () => query), { concurrency: "unbounded" }),
                            asIngest(p, (write) => write.put("skill", { id: "s2", name: "second" })),
                            Effect.all(Array.from({ length: 8 }, () => query), { concurrency: "unbounded" }),
                        ],
                        { concurrency: "unbounded" },
                    );
                    return [...before, ...after].map((rows) => rows.map((r) => r.name));
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );

            expect(names).toHaveLength(16);
            // Each result is either the pre- or the post-publish snapshot; a
            // half-open/closed handle would have failed the query instead.
            for (const result of names) {
                expect([["first"], ["first", "second"]]).toContainEqual(result);
            }
        });
    });

    dtest("a corrupt snapshot is a typed failure, never an empty result", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-corrupt-");
            writeFileSync(p.snapshotPath, "this is not a duckdb file");

            const exit = await Effect.runPromiseExit(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.raw("SELECT 1");
                }).pipe(
                    Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath })),
                ) as Effect.Effect<unknown, unknown>,
            );

            expect(exit._tag).toBe("Failure");
            expect(JSON.stringify(exit)).toContain("CacheUnavailableError");
        });
    });
});

describe("FTS", () => {
    const TURN_FTS: FtsTarget = { table: "turn", idColumn: "id", textColumn: "text_excerpt" };

    dtest("match_bm25 scores the matching row and only the matching row", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-fts-");
            const ts = new Date("2026-08-15T10:00:00.000Z");

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.putMany("turn", [
                            { id: "t1", text_excerpt: "the seam owns semantics the ddl cannot express", ts },
                            { id: "t2", text_excerpt: "an unrelated note about pastry", ts },
                            { id: "t3", text_excerpt: "another semantics discussion entirely", ts },
                        ]);
                        yield* buildFtsIndexes(write, [TURN_FTS]);

                        return yield* write.rows(
                            Schema.Struct({ id: Schema.String }),
                            `SELECT t.id AS id FROM turn t
                             WHERE ${matchBm25Sql(TURN_FTS, "t")} IS NOT NULL
                             ORDER BY t.id`,
                            ["semantics"],
                        );
                    }),
                ),
            );

            const hits = outcome._tag === "completed" ? outcome.value.map((r) => r.id) : [];
            expect(hits).toEqual(["t1", "t3"]);
        });
    });

    dtest("the index survives a rebuild and an empty table", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-fts-rebuild-");
            const ts = new Date("2026-08-15T10:00:00.000Z");

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        // Empty table first: building an index over nothing must work.
                        yield* buildFtsIndexes(write, [TURN_FTS]);
                        yield* write.put("turn", { id: "t1", text_excerpt: "duckdb seam", ts });
                        // ...and rebuilding must pick the new row up (overwrite = 1).
                        yield* buildFtsIndexes(write, [TURN_FTS]);

                        return yield* write.rows(
                            Schema.Struct({ id: Schema.String }),
                            `SELECT t.id AS id FROM turn t WHERE ${matchBm25Sql(TURN_FTS, "t")} IS NOT NULL`,
                            ["duckdb"],
                        );
                    }),
                ),
            );

            expect(outcome._tag === "completed" ? outcome.value.map((r) => r.id) : []).toEqual(["t1"]);
        });
    });

    dtest("the query term is a bound parameter - a quote in it cannot break the statement", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-fts-inject-");
            const ts = new Date("2026-08-15T10:00:00.000Z");

            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("turn", { id: "t1", text_excerpt: "harmless content", ts });
                        yield* buildFtsIndexes(write, [TURN_FTS]);
                        return yield* write.rows(
                            Schema.Struct({ id: Schema.String }),
                            `SELECT t.id AS id FROM turn t WHERE ${matchBm25Sql(TURN_FTS, "t")} IS NOT NULL`,
                            ["'; DROP TABLE turn; --"],
                        );
                    }),
                ),
            );

            // No hits, no error, and the table is still there.
            expect(outcome._tag).toBe("completed");
            expect(outcome._tag === "completed" ? outcome.value : null).toEqual([]);
        });
    });
});
