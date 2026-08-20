import { describe } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { duckdbTestSetup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/testing/duckdb-dylib.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("dup id");

describe("duplicate conflict key in one statement", () => {
    dtest("multi-row VALUES upsert with a repeated id", withDuckDb((db) =>
        Effect.gen(function* () {
            const conn = yield* db.open(join(tempDir("ax-dup-"), "d.duckdb"));
            yield* conn.exec('CREATE TABLE t (id VARCHAR PRIMARY KEY, v VARCHAR)');
            const r = yield* Effect.result(conn.exec(
                `INSERT INTO t (id, v) VALUES (?,?),(?,?),(?,?) ON CONFLICT ("id") DO UPDATE SET v = excluded.v`,
                ["a", "1", "b", "2", "a", "3"],
            ));
            console.log("VALUES dup =>", r._tag, r._tag === "Failure" ? String((r as any).failure.message).slice(0,180) : "rowsChanged=" + (r as any).success);
            const rows = yield* conn.query("SELECT id, v FROM t ORDER BY id");
            console.log("table after:", JSON.stringify(rows.rows));
            yield* conn.close;
        }),
    ), 60000);
});
