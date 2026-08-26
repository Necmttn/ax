/**
 * `ax ingest repair-indexes` (#1084), against a REAL DuckDB.
 *
 * Covers: discovery is limited to explicit secondary indexes (never a
 * primary-key or constraint-backed index, which never appear in
 * `duckdb_indexes()` for this DuckDB build in the first place - see the
 * module header); one-index-at-a-time rebuild with compensation after failure;
 * dry-run touches no catalog state; and the publish gate gets tripped by any
 * failure and satisfied only when every discovered index repaired cleanly.
 */
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, type Result } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { withCacheWrite, type CacheWriteError, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { FixturePlatform, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    INDEX_REPAIR_SCOPE_NOTE,
    cmdIngestRepairIndexes,
    formatIndexRepairResult,
    listRepairableIndexes,
    planPublish,
    repairIndexList,
    repairOneIndex,
    runIndexRepair,
    type RepairableIndex,
} from "./repair-indexes.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("repair-indexes");

const FIXTURE_DDL = `
CREATE TABLE IF NOT EXISTS widget (
    id VARCHAR PRIMARY KEY,
    a VARCHAR UNIQUE,
    b BIGINT,
    CONSTRAINT widget_b_named_uq UNIQUE (b)
);
CREATE INDEX IF NOT EXISTS widget_b_idx ON widget(b);
CREATE UNIQUE INDEX IF NOT EXISTS widget_a_c_uq ON widget(a, id);
`;

interface Paths {
    readonly dir: string;
    readonly livePath: string;
    readonly lockPath: string;
    readonly snapshotPath: string;
}

const paths = (prefix: string): Paths => {
    const dir = tempDir(prefix);
    return {
        dir,
        livePath: `${dir}/live.duckdb`,
        lockPath: `${dir}/ingest.lock`,
        snapshotPath: `${dir}/snapshot.duckdb`,
    };
};

/** Open the fixture live db under the ingest lock and run `body`. Mirrors
 *  the real command's own explicit schema handling so tests can seed data
 *  (schemaSql = FIXTURE_DDL) or exercise repair with schema application
 *  disabled (schemaSql = null), exactly as the command does. `publish`
 *  mirrors `CacheWriteOptions.publish` - default `false` so a test opts in
 *  only when it actually means to exercise `withCacheWrite`'s on-success
 *  publish gate. `body`'s error type is left for Effect to infer rather than
 *  pinned to `CacheWriteError`, since some callers below exercise the
 *  module's own typed errors (`IndexRestoreFailedError`,
 *  `IndexRepairIncompleteError`), which are not `CacheWriteError`s. */
const openFixture = <A, E>(
    p: Paths,
    schemaSql: string | null,
    body: (write: CacheWriteService) => Effect.Effect<A, E, never>,
    publish = false,
): Promise<A> =>
    runWithPlatform(
        Effect.gen(function* () {
            const outcome = yield* withIngestLock(
                {
                    lockPath: p.lockPath,
                    command: "repair-indexes-test",
                    staleMs: 60_000,
                    onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
                },
                withCacheWrite(
                    {
                        livePath: p.livePath,
                        lockPath: p.lockPath,
                        snapshotPath: p.snapshotPath,
                        schemaSql,
                        publish,
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    },
                    body,
                ),
            );
            if (outcome._tag !== "completed") {
                throw new Error(`ingest run did not complete: ${outcome._tag}`);
            }
            return outcome.value;
        }),
    );

/** Like `openFixture`, but captures the write body's success/failure OUTSIDE
 *  `withCacheWrite` via `Effect.result`, exactly where `cmdIngestRepairIndexes`
 *  itself catches `IndexRepairIncompleteError` - so these tests observe the
 *  SAME thing `withCacheWrite` observed when deciding whether to publish,
 *  rather than a body that already swallowed its own failure. */
const openFixtureResult = <A, E>(
    p: Paths,
    schemaSql: string | null,
    body: (write: CacheWriteService) => Effect.Effect<A, E, never>,
    publish: boolean,
): Promise<Result.Result<A, E | CacheWriteError>> =>
    runWithPlatform(
        Effect.gen(function* () {
            const outcome = yield* withIngestLock(
                {
                    lockPath: p.lockPath,
                    command: "repair-indexes-test",
                    staleMs: 60_000,
                    onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
                },
                withCacheWrite(
                    {
                        livePath: p.livePath,
                        lockPath: p.lockPath,
                        snapshotPath: p.snapshotPath,
                        schemaSql,
                        publish,
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    },
                    body,
                ).pipe(Effect.result),
            );
            if (outcome._tag !== "completed") {
                throw new Error(`ingest run did not complete: ${outcome._tag}`);
            }
            return outcome.value;
        }),
    );

const seedWidgets = (write: CacheWriteService) =>
    write.exec(
        "INSERT INTO widget (id, a, b) VALUES ('w1', 'alpha', 1), ('w2', 'beta', 2), ('w3', 'gamma', 3)",
    );

const indexNames = (rows: ReadonlyArray<{ readonly indexName: string }>): readonly string[] =>
    [...rows].map((r) => r.indexName).sort();

describe("listRepairableIndexes", () => {
    dtest("lists only explicit secondary indexes - never the primary key or the named UNIQUE constraint", async () => {
        const p = paths("ax-ridx-list-");
        const found = await openFixture(p, FIXTURE_DDL, (write) => listRepairableIndexes(write));

        expect(indexNames(found)).toEqual(["widget_a_c_uq", "widget_b_idx"]);
        const byName = new Map(found.map((f) => [f.indexName, f]));
        expect(byName.get("widget_a_c_uq")?.isUnique).toBe(true);
        expect(byName.get("widget_b_idx")?.isUnique).toBe(false);
        expect(byName.get("widget_a_c_uq")?.createSql).toContain("CREATE UNIQUE INDEX");
        // Never a PK or the table-level named UNIQUE constraint on `b`.
        expect(found.some((f) => f.indexName === "widget_b_named_uq")).toBe(false);
        expect(found.some((f) => f.tableName === "widget" && f.indexName.includes("pkey"))).toBe(false);
    });
});

describe("repairOneIndex", () => {
    dtest("rebuilds a non-unique index and it still works", async () => {
        const p = paths("ax-ridx-one-nonunique-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);

        const outcome = await openFixture(p, null, (write) =>
            repairOneIndex(write, {
                indexName: "widget_b_idx",
                tableName: "widget",
                isUnique: false,
                createSql: "CREATE INDEX widget_b_idx ON widget(b);",
            }),
        );
        expect(outcome).toEqual({ indexName: "widget_b_idx", tableName: "widget", status: "repaired" });

        const after = await openFixture(p, null, (write) =>
            Effect.all([
                write.raw("SELECT sql FROM duckdb_indexes() WHERE index_name = 'widget_b_idx'"),
                write.raw("SELECT count(*) AS n FROM widget WHERE b = 2"),
            ]),
        );
        expect(after[0].rows[0]?.["sql"]).toBe("CREATE INDEX widget_b_idx ON widget(b);");
        expect(Number(after[1].rows[0]?.["n"])).toBe(1);
    });

    dtest("rebuilds a unique index and it still works", async () => {
        const p = paths("ax-ridx-one-unique-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);

        const outcome = await openFixture(p, null, (write) =>
            repairOneIndex(write, {
                indexName: "widget_a_c_uq",
                tableName: "widget",
                isUnique: true,
                createSql: "CREATE UNIQUE INDEX widget_a_c_uq ON widget(a, id);",
            }),
        );
        expect(outcome.status).toBe("repaired");

        // The uniqueness constraint is genuinely back in force: a duplicate
        // insert must fail.
        const rejected = await openFixture(p, null, (write) =>
            write.exec("INSERT INTO widget (id, a, b) VALUES ('w1', 'alpha', 99)").pipe(
                Effect.map(() => "inserted" as const),
                Effect.catch(() => Effect.succeed("rejected" as const)),
            ),
        );
        expect(rejected).toBe("rejected");
    });

    dtest("a recreation failure restores the original index and leaves rows untouched", async () => {
        const p = paths("ax-ridx-one-fail-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);
        const before = await openFixture(p, null, (write) =>
            write.raw("SELECT sql FROM duckdb_indexes() WHERE index_name = 'widget_b_idx'"),
        );

        const outcome = await openFixture(p, null, (write) =>
            repairOneIndex(write, {
                indexName: "widget_b_idx",
                tableName: "widget",
                isUnique: false,
                // Deliberately bad: references a column that does not exist,
                // so CREATE INDEX fails after the DROP. The compensating
                // action must restore the captured original definition.
                createSql: "CREATE INDEX widget_b_idx ON widget(does_not_exist);",
            }),
        );
        expect(outcome.status).toBe("failed");
        expect(outcome.error).toContain("does_not_exist");

        const after = await openFixture(p, null, (write) =>
            Effect.all([
                write.raw("SELECT sql FROM duckdb_indexes() WHERE index_name = 'widget_b_idx'"),
                write.raw("SELECT count(*) AS n FROM widget"),
            ]),
        );
        expect(after[0].rows[0]?.["sql"]).toBe(before.rows[0]?.["sql"]);
        expect(Number(after[1].rows[0]?.["n"])).toBe(3);
    });
});

describe("planPublish", () => {
    const outcome = (status: "repaired" | "failed" | "would-repair"): { status: typeof status } => ({ status });

    test("publishes when at least one index was repaired and none failed", () => {
        expect(planPublish([outcome("repaired"), outcome("repaired")])).toBe(true);
    });

    test("refuses when any index failed, even alongside successes", () => {
        expect(planPublish([outcome("repaired"), outcome("failed")])).toBe(false);
    });

    test("refuses when nothing needed repairing (no-op run)", () => {
        expect(planPublish([])).toBe(false);
    });

    test("refuses for a dry-run's would-repair outcomes", () => {
        expect(planPublish([outcome("would-repair"), outcome("would-repair")])).toBe(false);
    });
});

describe("repairIndexList: dry-run changes no catalog state", () => {
    dtest("dry-run reports would-repair for every discovered index and mutates nothing", async () => {
        const p = paths("ax-ridx-dryrun-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);
        const before = await openFixture(p, null, (write) =>
            write.raw("SELECT index_name, sql FROM duckdb_indexes() WHERE table_name = 'widget' ORDER BY index_name"),
        );

        const indexes: readonly RepairableIndex[] = await openFixture(p, null, (write) =>
            listRepairableIndexes(write),
        );
        const result = await openFixture(p, null, (write) => repairIndexList(write, indexes, true));

        expect(result.dryRun).toBe(true);
        expect(result.repaired).toBe(0);
        expect(result.failed).toBe(0);
        expect(indexNames(result.outcomes)).toEqual(["widget_a_c_uq", "widget_b_idx"]);
        expect(result.outcomes.every((o) => o.status === "would-repair")).toBe(true);

        const after = await openFixture(p, null, (write) =>
            write.raw("SELECT index_name, sql FROM duckdb_indexes() WHERE table_name = 'widget' ORDER BY index_name"),
        );
        expect(after.rows).toEqual(before.rows);

        // No snapshot published either - dry-run touches nothing.
        const fs = await runWithPlatform(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.exists(p.snapshotPath);
            }),
        );
        expect(fs).toBe(false);
    });
});

describe("repairIndexList: publish gating", () => {
    // `repairIndexList` itself never publishes anything (#1084 review: the
    // old implementation reached for `CacheWriteService.publishIntermediateSnapshot()`,
    // a narrow escape hatch reserved for ingest's cold-start path - see the
    // module header). Publishing is `withCacheWrite`'s own on-success gate,
    // so these tests open with `publish: true` and prove the gate by whether
    // `repairIndexList`'s body SUCCEEDS or FAILS.
    dtest("publishes when every discovered index repairs cleanly", async () => {
        const p = paths("ax-ridx-allok-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);
        const indexes: readonly RepairableIndex[] = await openFixture(p, null, (write) =>
            listRepairableIndexes(write),
        );

        const result = await openFixture(p, null, (write) => repairIndexList(write, indexes, false), true);
        expect(result.repaired).toBe(2);
        expect(result.failed).toBe(0);

        const fs = await runWithPlatform(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.exists(p.snapshotPath);
            }),
        );
        expect(fs).toBe(true);
    });

    dtest("does NOT publish when one index fails to rebuild - even if others succeeded", async () => {
        const p = paths("ax-ridx-onefail-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);
        const real: readonly RepairableIndex[] = await openFixture(p, null, (write) =>
            listRepairableIndexes(write),
        );
        const broken: readonly RepairableIndex[] = real.map((idx) =>
            idx.indexName === "widget_b_idx"
                ? { ...idx, createSql: "CREATE INDEX widget_b_idx ON widget(does_not_exist);" }
                : idx,
        );

        // `repairIndexList` fails its own body (IndexRepairIncompleteError)
        // when the pass is not a clean sweep - exactly what stops
        // `withCacheWrite`'s on-success publish from firing even though
        // `publish: true` is set below. Observe that failure the same way
        // `withCacheWrite` did (outside its own body), via `openFixtureResult`.
        const outcome = await openFixtureResult(p, null, (write) => repairIndexList(write, broken, false), true);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag !== "Failure") throw new Error("expected repairIndexList to fail");
        expect(outcome.failure._tag).toBe("IndexRepairIncompleteError");
        if (outcome.failure._tag !== "IndexRepairIncompleteError") throw new Error("expected IndexRepairIncompleteError");
        expect(outcome.failure.result.repaired).toBe(1);
        expect(outcome.failure.result.failed).toBe(1);

        const fs = await runWithPlatform(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.exists(p.snapshotPath);
            }),
        );
        expect(fs).toBe(false);

        // The failed index's ORIGINAL definition survives - restored, not
        // left dropped - even though this run never published.
        const catalog = await openFixture(p, null, (write) =>
            write.raw("SELECT sql FROM duckdb_indexes() WHERE index_name = 'widget_b_idx'"),
        );
        expect(catalog.rows[0]?.["sql"]).toBe("CREATE INDEX widget_b_idx ON widget(b);");
    });

    dtest("does NOT publish when nothing was discovered to repair (no-op run)", async () => {
        const p = paths("ax-ridx-noop-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);

        const outcome = await openFixtureResult(p, null, (write) => repairIndexList(write, [], false), true);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag !== "Failure") throw new Error("expected repairIndexList to fail");
        expect(outcome.failure._tag).toBe("IndexRepairIncompleteError");
        if (outcome.failure._tag !== "IndexRepairIncompleteError") throw new Error("expected IndexRepairIncompleteError");
        expect(outcome.failure.result.repaired).toBe(0);
        expect(outcome.failure.result.failed).toBe(0);
        expect(outcome.failure.result.outcomes.length).toBe(0);

        const fs = await runWithPlatform(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.exists(p.snapshotPath);
            }),
        );
        expect(fs).toBe(false);
    });

    dtest(
        "a compensating-restore failure propagates as IndexRestoreFailedError, leaves the index dropped, " +
            "and blocks publish",
        async () => {
            const p = paths("ax-ridx-restore-fail-");
            await openFixture(p, FIXTURE_DDL, seedWidgets);
            const indexes: readonly RepairableIndex[] = await openFixture(p, null, (write) =>
                listRepairableIndexes(write),
            );
            const target = indexes.find((idx) => idx.indexName === "widget_a_c_uq");
            if (target === undefined) throw new Error("fixture is missing widget_a_c_uq");
            const originalSql = target.createSql;
            const broken: readonly RepairableIndex[] = indexes.map((idx) =>
                idx.indexName === "widget_a_c_uq"
                    ? { ...idx, createSql: "CREATE UNIQUE INDEX widget_a_c_uq ON widget(a, does_not_exist);" }
                    : idx,
            );

            const outcome = await openFixtureResult(
                p,
                null,
                (write) => {
                    // Sabotage ONLY the compensating restore: right as
                    // `repairOneIndex` re-runs the captured original
                    // definition (verbatim SQL match, so neither the bad
                    // CREATE nor the DROP is affected), sneak in a
                    // primary-key-violating duplicate `id` row first, so the
                    // restore's own exec call fails outright before it ever
                    // reaches the real CREATE UNIQUE INDEX statement.
                    const sabotaged: CacheWriteService = {
                        ...write,
                        exec: (sql, params) =>
                            sql === originalSql
                                ? write
                                      .exec("INSERT INTO widget (id, a, b) VALUES ('w1', 'alpha', 99)")
                                      .pipe(Effect.flatMap(() => write.exec(sql, params)))
                                : write.exec(sql, params),
                    };
                    return repairIndexList(sabotaged, broken, false);
                },
                true,
            );

            expect(outcome._tag).toBe("Failure");
            if (outcome._tag === "Failure") {
                expect(outcome.failure._tag).toBe("IndexRestoreFailedError");
                if (outcome.failure._tag === "IndexRestoreFailedError") {
                    expect(outcome.failure.indexName).toBe("widget_a_c_uq");
                }
            }

            // The catalog is left WITHOUT the index at all - the DROP
            // succeeded, and BOTH the sabotaged CREATE and the compensating
            // restore failed. This is exactly why it must be fatal rather
            // than a per-index "failed" outcome.
            const catalog = await openFixture(p, null, (write) =>
                write.raw("SELECT sql FROM duckdb_indexes() WHERE index_name = 'widget_a_c_uq'"),
            );
            expect(catalog.rows.length).toBe(0);

            const fs = await runWithPlatform(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    return yield* fs.exists(p.snapshotPath);
                }),
            );
            expect(fs).toBe(false);
        },
    );
});

describe("runIndexRepair", () => {
    dtest("discovers and repairs every explicit secondary index end to end", async () => {
        const p = paths("ax-ridx-e2e-");
        await openFixture(p, FIXTURE_DDL, seedWidgets);

        const result = await openFixture(p, null, (write) => runIndexRepair(write, { dryRun: false }));
        expect(result.repaired).toBe(2);
        expect(result.failed).toBe(0);
        expect(indexNames(result.outcomes)).toEqual(["widget_a_c_uq", "widget_b_idx"]);
    });
});

describe("formatIndexRepairResult", () => {
    test("states the primary/constraint scope boundary in every mode", () => {
        expect(formatIndexRepairResult({ dryRun: true, outcomes: [], repaired: 0, failed: 0 })).toContain(
            INDEX_REPAIR_SCOPE_NOTE,
        );
        expect(
            formatIndexRepairResult({
                dryRun: false,
                outcomes: [{ indexName: "x", tableName: "t", status: "repaired" }],
                repaired: 1,
                failed: 0,
            }),
        ).toContain(INDEX_REPAIR_SCOPE_NOTE);
    });

    test("says the snapshot was not published when a repair failed", () => {
        const text = formatIndexRepairResult({
            dryRun: false,
            outcomes: [
                { indexName: "ok", tableName: "t", status: "repaired" },
                { indexName: "bad", tableName: "t", status: "failed", error: "boom" },
            ],
            repaired: 1,
            failed: 1,
        });
        expect(text).toContain("snapshot NOT published");
        expect(text).toContain("FAILED  t.bad - boom");
    });

    test("dry-run states every discovered index would be repaired, not 0/N", () => {
        const text = formatIndexRepairResult({
            dryRun: true,
            outcomes: [
                { indexName: "a", tableName: "t", status: "would-repair" },
                { indexName: "b", tableName: "t", status: "would-repair" },
            ],
            repaired: 0,
            failed: 0,
        });
        expect(text).toContain("would repair 2/2 explicit secondary index(es)");
        expect(text).not.toContain("would repair 0/2");
    });
});

describe("cmdIngestRepairIndexes: the CLI composition", () => {
    dtest("acquires the lock, opens with schema disabled, and repairs against AxConfig's dataDir", async () => {
        // Seeded at the SAME filenames `cmdIngestRepairIndexes` itself
        // resolves from `AxConfig.paths.dataDir` (`ax-live.duckdb` /
        // `ingest.lock` / `ax-snapshot.duckdb` - see `maintenanceCacheWriteOptions`
        // in cli/commands/ingest.ts, the same convention every other
        // dataDir-rooted maintenance write uses) - NOT the generic
        // `live.duckdb`/`snapshot.duckdb` names the other describe blocks in
        // this file use for their own directly-supplied `CacheWriteOptions`.
        const dir = tempDir("ax-ridx-cli-");
        const p: Paths = {
            dir,
            livePath: `${dir}/ax-live.duckdb`,
            lockPath: `${dir}/ingest.lock`,
            snapshotPath: `${dir}/ax-snapshot.duckdb`,
        };
        await openFixture(p, FIXTURE_DDL, seedWidgets);

        const result = await Effect.runPromise(
            cmdIngestRepairIndexes({ dryRun: false }).pipe(
                Effect.provide(
                    AxConfigTest({ paths: { dataDir: p.dir } }).pipe(Layer.provideMerge(FixturePlatform)),
                ),
            ),
        );
        expect(result.repaired).toBe(2);
        expect(result.failed).toBe(0);
    });
});
