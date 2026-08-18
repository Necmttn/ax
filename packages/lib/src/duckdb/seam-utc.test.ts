/**
 * THE UTC CONTRACT, on a genuinely non-UTC host.
 *
 * WHY THIS SUITE RE-EXECS ITSELF. The zone DuckDB uses is read from the
 * environment when the icu extension initialises, so mutating
 * `process.env.TZ` inside a running test changes NOTHING that DuckDB can see -
 * measured: an in-process `process.env.TZ = "Asia/Makassar"` still reports
 * `current_setting('TimeZone') = 'UTC'` and zero skew. Every "non-UTC host"
 * test written that way is vacuous and passes whatever the seam does. So the
 * outer test SPAWNS this same file with `TZ` set in the CHILD's environment,
 * and the child (marked by {@link CHILD_ENV}) carries the real assertions.
 *
 * WHAT IT PROVES, and why it needs the icu-linked dylib to prove it. Against
 * the OFFICIAL v1.5.5 build - what `vendor/duckdb/` downloads and what CI
 * runs - `TimeZone` IS in the catalog and defaults to the host zone. Measured
 * under `TZ=Asia/Makassar` (UTC+8, no DST) against that build:
 *
 *   | connection            | CAST(CURRENT_TIMESTAMP AS TIMESTAMP) | DDL DEFAULT |
 *   | no `SET TimeZone`     | +480 min (local wall time)            | +480 min    |
 *   | `SET TimeZone='UTC'`  | 0                                     | 0           |
 *
 * So on such a host an unpinned writer stores LOCAL time in columns the DDL
 * declares UTC - and once the seam asserted the clock instead of pinning it,
 * that same host had every `withCacheWrite` REFUSED before its body ran. Both
 * failure modes are covered below.
 */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { join } from "node:path";
import { withIngestLock } from "../ingest-lock.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { TimestampColumn } from "./columns.ts";
import { CacheRead, CacheReadLayer, withCacheWrite, type CacheWriteService } from "./seam.ts";

/** Set in the re-exec'd child, whose `TZ` is the whole point of the suite. */
const CHILD_ENV = "AX_SEAM_UTC_CHILD";

/** UTC+8, no DST - the offset is the same whenever the suite runs. */
const NON_UTC_TZ = "Asia/Makassar";

/** Comfortably above real clock skew, far below any time-zone offset (the
 *  smallest real one is 15 minutes). */
const SKEW_TOLERANCE_MS = 60_000;

const isChild = process.env[CHILD_ENV] === "1";

const DDL = `
CREATE TABLE IF NOT EXISTS skill (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS defaulted (
    id VARCHAR PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

if (!isChild) {
    describe("the UTC contract on a non-UTC host", () => {
        test(
            `re-exec under TZ=${NON_UTC_TZ}: writes are pinned to UTC, not refused`,
            () => {
                const child = Bun.spawnSync(["bun", "test", import.meta.path], {
                    env: { ...process.env, [CHILD_ENV]: "1", TZ: NON_UTC_TZ },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
                // The child's own failures are the signal; surface them here so a
                // regression reads like a normal test failure instead of "exit 1".
                expect(output).not.toContain("(fail)");
                expect(child.exitCode).toBe(0);
                // A child that skipped its whole suite (no dylib) must not read as
                // a pass - the outer gate forbids loudly-skipped suites.
                expect(output).toMatch(/\d+ pass/);
            },
            120_000,
        );
    });
} else {
    const { dylibPath, dtest, tempDir } = await duckdbTestSetup("duckdb seam UTC");

    const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
        Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

    const paths = (prefix: string) => {
        const dir = tempDir(prefix);
        return {
            livePath: join(dir, "live.duckdb"),
            lockPath: join(dir, "ingest.lock"),
            snapshotPath: join(dir, "snapshot.duckdb"),
        };
    };

    const asIngest = <A, E>(
        p: ReturnType<typeof paths>,
        body: (write: CacheWriteService) => Effect.Effect<A, E, never>,
    ) =>
        withIngestLock(
            {
                lockPath: p.lockPath,
                command: "seam-utc-test",
                staleMs: 60_000,
                onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
            },
            withCacheWrite(
                {
                    livePath: p.livePath,
                    lockPath: p.lockPath,
                    snapshotPath: p.snapshotPath,
                    schemaSql: DDL,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                },
                body,
            ),
        );

    const readLayer = (snapshotPath: string) =>
        CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) });

    describe(`seam connections under TZ=${NON_UTC_TZ}`, () => {
        dtest("the host really is non-UTC (otherwise everything below is vacuous)", () => {
            expect(process.env.TZ).toBe(NON_UTC_TZ);
            expect(new Date().getTimezoneOffset()).not.toBe(0);
        });

        dtest("a seam-stamped column lands at UTC now, and the write is not refused", async () => {
            const p = paths("ax-seam-utc-stamp-");
            const before = Date.now();
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s1", name: "utc" });
                        return yield* write.rows(
                            Schema.Struct({ ingested_at: TimestampColumn }),
                            "SELECT ingested_at FROM skill",
                        );
                    }),
                ),
            );
            const after = Date.now();

            // An asserted-but-unpinned clock failed here, before the body ran.
            expect(outcome._tag).toBe("completed");
            const stamped = (outcome._tag === "completed" ? outcome.value : [])[0]?.ingested_at.getTime() ?? 0;
            expect(stamped).toBeGreaterThanOrEqual(before - SKEW_TOLERANCE_MS);
            expect(stamped).toBeLessThanOrEqual(after + SKEW_TOLERANCE_MS);
        });

        dtest("a DDL DEFAULT CURRENT_TIMESTAMP column lands at UTC now", async () => {
            const p = paths("ax-seam-utc-default-");
            const before = Date.now();
            const outcome = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        // No `created_at` in the row, so the value comes from the
                        // DDL default and the database's clock alone.
                        yield* write.put("defaulted", { id: "d1" });
                        return yield* write.rows(
                            Schema.Struct({ created_at: TimestampColumn }),
                            "SELECT created_at FROM defaulted",
                        );
                    }),
                ),
            );
            const after = Date.now();

            const created = (outcome._tag === "completed" ? outcome.value : [])[0]?.created_at.getTime() ?? 0;
            expect(created).toBeGreaterThanOrEqual(before - SKEW_TOLERANCE_MS);
            expect(created).toBeLessThanOrEqual(after + SKEW_TOLERANCE_MS);
        });

        dtest("the READ connection is pinned too, so CURRENT_TIMESTAMP is UTC there", async () => {
            const p = paths("ax-seam-utc-read-");
            await run(asIngest(p, (write) => write.put("skill", { id: "s1", name: "read" })));

            const skew = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    const rows = yield* read.rows(
                        Schema.Struct({ db_now: TimestampColumn }),
                        "SELECT CAST(CURRENT_TIMESTAMP AS TIMESTAMP) AS db_now",
                    );
                    return rows[0]!.db_now.getTime() - Date.now();
                }).pipe(Effect.provide(readLayer(p.snapshotPath))),
            );

            // An unpinned read connection reports LOCAL wall time - what every
            // `CURRENT_TIMESTAMP`-relative read filter would compare UTC rows to.
            expect(Math.abs(skew)).toBeLessThan(SKEW_TOLERANCE_MS);
        });

        dtest("a stamped write reads back identically through the published snapshot", async () => {
            const p = paths("ax-seam-utc-roundtrip-");
            const written = await run(
                asIngest(p, (write) =>
                    Effect.gen(function* () {
                        yield* write.put("skill", { id: "s1", name: "roundtrip" });
                        const rows = yield* write.rows(
                            Schema.Struct({ ingested_at: TimestampColumn }),
                            "SELECT ingested_at FROM skill",
                        );
                        return rows[0]!.ingested_at.toISOString();
                    }),
                ),
            );

            const readBack = await run(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    const rows = yield* read.rows(
                        Schema.Struct({ ingested_at: TimestampColumn }),
                        "SELECT ingested_at FROM skill",
                    );
                    return rows[0]!.ingested_at.toISOString();
                }).pipe(Effect.provide(readLayer(p.snapshotPath))),
            );

            expect(readBack).toBe(written._tag === "completed" ? written.value : "<not written>");
        });
    });
}
