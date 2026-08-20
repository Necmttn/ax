import { describe } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { duckdbTestSetup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/testing/duckdb-dylib.ts";
import { ftsDigestSql, TURN_FTS_TARGET } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/fts.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("fts digest");
const workDir = () => tempDir("ax-fts-digest-");

describe("fts digest formula", () => {
    dtest("is hash(a,b) xor-combining?", withDuckDb((db) =>
        Effect.gen(function* () {
            const conn = yield* db.open(join(workDir(), "d.duckdb"));
            const probe = yield* conn.query(
                "SELECT hash('aa','bb')::VARCHAR AS ab, hash('bb','aa')::VARCHAR AS ba, xor(hash('aa'), hash('bb'))::VARCHAR AS x, hash('aa')::VARCHAR AS a, hash('bb')::VARCHAR AS b",
            );
            console.log("HASH PROBE:", JSON.stringify(probe.rows));

            // real scenario: two turns swap their text
            yield* conn.exec('CREATE TABLE turn (id VARCHAR PRIMARY KEY, text VARCHAR)');
            yield* conn.exec("INSERT INTO turn VALUES ('t1','alpha content'),('t2','beta content')");
            const d1 = yield* conn.query(ftsDigestSql(TURN_FTS_TARGET));
            console.log("digest before swap:", JSON.stringify(d1.rows));
            yield* conn.exec("UPDATE turn SET text = 'beta content' WHERE id='t1'");
            yield* conn.exec("UPDATE turn SET text = 'alpha content' WHERE id='t2'");
            const d2 = yield* conn.query(ftsDigestSql(TURN_FTS_TARGET));
            console.log("digest after swap: ", JSON.stringify(d2.rows));
            console.log("SAME DIGEST?", JSON.stringify(d1.rows) === JSON.stringify(d2.rows));

            // control: a genuine single-row edit
            yield* conn.exec("UPDATE turn SET text = 'gamma' WHERE id='t1'");
            const d3 = yield* conn.query(ftsDigestSql(TURN_FTS_TARGET));
            console.log("digest after real edit:", JSON.stringify(d3.rows));
            yield* conn.close;
        }),
    ), 60000);
});
