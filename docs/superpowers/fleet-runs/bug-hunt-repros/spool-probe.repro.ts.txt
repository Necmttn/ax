import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { duckdbTestSetup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/testing/duckdb-dylib.ts";
import { makeTableSpool } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/spool.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("spool probe");
const workDir = () => tempDir("ax-spool-probe-");

const DDL = `CREATE TABLE IF NOT EXISTS t (
  id VARCHAR PRIMARY KEY,
  text VARCHAR,
  n BIGINT,
  d DOUBLE,
  ts TIMESTAMP
);`;

// minimal CacheWriteService stand-in over a real connection
const fakeWrite = (conn: any): any => ({
    exec: (sql: string, params?: readonly unknown[]) => conn.exec(sql, params),
    rows: () => Effect.succeed([]),
    first: () => Effect.succeed(null),
    raw: (sql: string, p?: readonly unknown[]) => conn.query(sql, p),
    put: () => Effect.void,
    putMany: () => Effect.void,
    nulStripped: () => ({ values: 0, statements: 0 }),
    livePath: "",
    snapshotPath: "",
});

describe("spool probes", () => {
    dtest("bigint > 2^53 round-trips exactly through read_ndjson", withDuckDb((db) =>
        Effect.gen(function* () {
            const dir = workDir();
            const conn = yield* db.open(join(dir, "live.duckdb"));
            yield* conn.exec(DDL);
            const spool = makeTableSpool({ tables: ["t"], dir: mkdtempSync(join(tmpdir(), "sp-")), ddlSql: DDL });
            spool.append("t", [{ id: "a", text: "x", n: 9007199254740993n, d: 1.5, ts: new Date("2026-08-20T12:34:56.789Z") }]);
            const out = yield* spool.flush(fakeWrite(conn));
            console.log("flush:", JSON.stringify(out));
            const r = yield* conn.query("SELECT id, n, d, ts::VARCHAR AS ts FROM t");
            console.log("ROW:", JSON.stringify(r.rows, (_k, v) => typeof v === "bigint" ? v.toString()+"n" : v));
            yield* conn.close;
        }),
    ), 60000);

    dtest("a >16MB text value in one spooled row", withDuckDb((db) =>
        Effect.gen(function* () {
            const dir = workDir();
            const conn = yield* db.open(join(dir, "live2.duckdb"));
            yield* conn.exec(DDL);
            const spool = makeTableSpool({ tables: ["t"], dir: mkdtempSync(join(tmpdir(), "sp2-")), ddlSql: DDL });
            const big = "z".repeat(20 * 1024 * 1024);
            spool.append("t", [{ id: "small", text: "ok", n: 1n, d: 1, ts: null }]);
            spool.append("t", [{ id: "big", text: big, n: 2n, d: 2, ts: null }]);
            const res = yield* Effect.result(spool.flush(fakeWrite(conn)));
            console.log("BIG flush:", res._tag, res._tag === "Failure" ? String((res as any).failure.message).slice(0, 400) : JSON.stringify((res as any).success));
            const c = yield* conn.query("SELECT CAST(count(*) AS DOUBLE) AS n FROM t");
            console.log("rows landed:", JSON.stringify(c.rows));
            yield* conn.close;
        }),
    ), 120000);

    dtest("two ids differing only by a lone surrogate collide after scrub", withDuckDb((db) =>
        Effect.gen(function* () {
            const dir = workDir();
            const conn = yield* db.open(join(dir, "live3.duckdb"));
            yield* conn.exec(DDL);
            const spool = makeTableSpool({ tables: ["t"], dir: mkdtempSync(join(tmpdir(), "sp3-")), ddlSql: DDL });
            spool.append("t", [
                { id: "k\uD800", text: "one", n: 1n, d: 1, ts: null },
                { id: "k\uDC00", text: "two", n: 2n, d: 2, ts: null },
            ]);
            console.log("pending:", spool.pendingRows());
            const res = yield* Effect.result(spool.flush(fakeWrite(conn)));
            console.log("SURROGATE flush:", res._tag, res._tag === "Failure" ? String((res as any).failure.message).slice(0, 300) : JSON.stringify((res as any).success));
            const r = yield* conn.query("SELECT id, text FROM t");
            console.log("rows:", JSON.stringify(r.rows));
            console.log("totals:", JSON.stringify(spool.totals()));
            yield* conn.close;
        }),
    ), 60000);
});
