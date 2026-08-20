import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { duckdbTestSetup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/testing/duckdb-dylib.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("fts publish");
const workDir = () => tempDir("ax-fts-publish-");

describe("fts survives publish", () => {
    dtest(
        "logical COPY FROM DATABASE path carries fts_main_* schema+macros",
        withDuckDb((db) =>
            Effect.gen(function* () {
                const dir = workDir();
                const live = join(dir, "live.duckdb");
                const snap = join(dir, "snapshot.duckdb");

                const rw = yield* db.open(live);
                yield* rw.exec("CREATE TABLE turn (id VARCHAR PRIMARY KEY, text VARCHAR)");
                yield* rw.exec("INSERT INTO turn VALUES ('a', 'hello duckdb world'), ('b', 'goodbye moon')");
                yield* rw.exec("LOAD fts");
                yield* rw.exec("PRAGMA create_fts_index('turn', 'id', 'text', overwrite = 1)");
                const liveHit = yield* rw.query(
                    "SELECT id FROM (SELECT id, fts_main_turn.match_bm25(id, ?) AS s FROM turn) WHERE s IS NOT NULL",
                    ["duckdb"],
                );
                console.log("LIVE hit:", JSON.stringify(liveHit.rows));
                const liveSchemas = yield* rw.query(
                    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'fts_%'",
                );
                console.log("LIVE schemas:", JSON.stringify(liveSchemas.rows));

                // force the LOGICAL path
                process.env.AX_SNAPSHOT_CLONE = "off";
                yield* db.publishSnapshot(live, snap, { from: rw });
                delete process.env.AX_SNAPSHOT_CLONE;
                yield* rw.close;

                expect(existsSync(snap)).toBe(true);
                const ro = yield* db.open(snap, { readOnly: true });
                const snapSchemas = yield* ro.query(
                    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'fts_%'",
                );
                console.log("SNAP schemas:", JSON.stringify(snapSchemas.rows));
                const snapTables = yield* ro.query(
                    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema LIKE 'fts_%'",
                );
                console.log("SNAP fts tables:", JSON.stringify(snapTables.rows));
                const res = yield* Effect.result(
                    ro.query(
                        "SELECT id FROM (SELECT id, fts_main_turn.match_bm25(id, ?) AS s FROM turn) WHERE s IS NOT NULL",
                        ["duckdb"],
                    ),
                );
                console.log("SNAP match_bm25 result:", res._tag, res._tag === "Failure" ? (res as any).failure.message : JSON.stringify((res as any).success.rows));
                yield* ro.close;
            }),
        ),
        60000,
    );
});
