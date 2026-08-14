/**
 * The seam, against a REAL DuckDB. Nothing here is mocked: every case opens a
 * real database file in a real temp directory, through the real dylib.
 */
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withIngestLock } from "../ingest-lock.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { TimestampColumn } from "./columns.ts";
import { buildFtsIndexes, matchBm25Sql, type FtsTarget } from "./fts.ts";
import {
    CacheRead,
    CacheReadLayer,
    WRITE_STAMPED_COLUMNS,
    withCacheWrite,
    type CacheWriteService,
} from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("duckdb seam");

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

    dtest("a stamped column is UTC even when the process runs on a non-UTC TZ", async () => {
        const previousTz = process.env.TZ;
        process.env.TZ = "Pacific/Kiritimati"; // UTC+14 - a full day off UTC at some hours
        try {
            await dylibEnv(async () => {
                const p = paths("ax-seam-tz-");
                const before = Date.now();
                const outcome = await run(
                    asIngest(p, (write) =>
                        Effect.gen(function* () {
                            yield* write.put("skill", { id: "s1", name: "tz" });
                            return yield* write.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                        }),
                    ),
                );
                const after = Date.now();

                const rows = outcome._tag === "completed" ? outcome.value : [];
                const stamped = rows[0]?.ingested_at.getTime() ?? 0;
                // Without the connection's TimeZone pin, CURRENT_TIMESTAMP would
                // be stored as LOCAL time and read back ~14h in the future.
                expect(stamped).toBeGreaterThanOrEqual(before - 5_000);
                expect(stamped).toBeLessThanOrEqual(after + 5_000);
            });
        } finally {
            if (previousTz === undefined) delete process.env.TZ;
            else process.env.TZ = previousTz;
        }
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
});

describe("CacheRead", () => {
    dtest("builds and tears down without opening anything when no query runs", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-lazy-");
            // No snapshot exists at all. Building and releasing the layer must
            // still succeed - this is the `ax serve` / `ax mcp` startup shape.
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

    dtest("a reader holding the old snapshot keeps reading it across a publish", async () => {
        await dylibEnv(async () => {
            const p = paths("ax-seam-inode-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "first" })));

            await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    // Open the snapshot (memoizes the connection on the OLD inode).
                    const initial = yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    expect(initial).toHaveLength(1);

                    // Republish with an extra row - an atomic rename over the path.
                    yield* asIngest(p, (write) => write.put("skill", { id: "s2", name: "second" }));

                    // The held handle still sees the snapshot it opened.
                    const after = yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill");
                    expect(after).toHaveLength(1);
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );

            // A FRESH reader sees both rows, so the publish really did land.
            const fresh = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.rows(SkillRow, "SELECT id, name, ingested_at FROM skill ORDER BY id");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath: p.snapshotPath }))),
            );
            expect(fresh.map((r) => r.name)).toEqual(["first", "second"]);
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
