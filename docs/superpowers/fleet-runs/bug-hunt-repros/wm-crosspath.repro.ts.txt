import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { join } from "node:path";
import { writeFileSync, statSync } from "node:fs";
import { duckdbTestSetup } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/testing/duckdb-dylib.ts";
import { fileWatermark, watermarkRow, WATERMARK_TABLE, hashFileSha256 } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/watermark.ts";

const { dtest, tempDir, withDuckDb } = await duckdbTestSetup("wm crosspath");
const workDir = () => tempDir("ax-wm-cross-");

const WM_DDL = `CREATE TABLE IF NOT EXISTS ingest_file_state (
  id VARCHAR PRIMARY KEY, path VARCHAR NOT NULL, source_kind VARCHAR NOT NULL,
  mtime_ms DOUBLE, size DOUBLE, sha VARCHAR, since_days DOUBLE,
  ingested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS ingest_file_state_path_uq ON ingest_file_state(path);`;

const wrap = (conn: any): any => {
    const svc: any = {
        exec: (sql: string, p?: readonly unknown[]) => conn.exec(sql, p),
        raw: (sql: string, p?: readonly unknown[]) => conn.query(sql, p),
        rows: (schema: any, sql: string, p?: readonly unknown[]) => conn.queryAs(schema, sql, p),
        first: (schema: any, sql: string, p?: readonly unknown[]) =>
            conn.queryAs(schema, sql, p).pipe(Effect.map((r: any[]) => r[0] ?? null)),
        put: (t: string, row: any) => svc.putMany(t, [row]),
        putMany: (t: string, rows: any[]) => Effect.gen(function* () {
            for (const row of rows) {
                const cols = Object.keys(row);
                yield* conn.exec(
                    `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")}) ` +
                    `ON CONFLICT ("id") DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `"${c}"=excluded."${c}"`).join(",")}`,
                    cols.map((c) => row[c]),
                );
            }
        }),
        nulStripped: () => ({ values: 0, statements: 0 }),
        livePath: "", snapshotPath: "",
    };
    return svc;
};

describe("watermark content-hash cross-path skip", () => {
    dtest("a byte-identical file at a NEW path is skipped, so path-derived fields never re-derive", withDuckDb((db) =>
        Effect.gen(function* () {
            const dir = workDir();
            const conn = yield* db.open(join(dir, "live.duckdb"));
            yield* conn.exec(WM_DDL);
            const write = wrap(conn);

            // Run 1: file at projA path is parsed and marked with its sha.
            const bytes = '{"sessionId":"s1","type":"user"}\n';
            const oldPath = join(dir, "-Users-x-projA", "s1.jsonl");
            const newPath = join(dir, "-Users-x-projB", "s1.jsonl");
            yield* Effect.promise(() => Bun.write(oldPath, bytes));
            yield* Effect.promise(() => Bun.write(newPath, bytes));
            const sha = yield* hashFileSha256(oldPath);
            const st = statSync(oldPath);
            yield* write.putMany(WATERMARK_TABLE, [
                watermarkRow("claude_transcript", oldPath, { mtimeMs: st.mtime.getTime(), size: st.size, sha }),
            ]);

            // Run 2: fresh watermark load; the NEW path has no mark of its own.
            const wm = yield* fileWatermark(write, {
                sourceKind: "claude_transcript",
                forceEnv: "AX_REDERIVE_CLAUDE_TEST",
                contentHash: true,
            });
            const newStat = statSync(newPath);
            console.log("unchanged(newPath)?", wm.unchanged(newPath, newStat.mtime.getTime(), newStat.size));
            console.log("storedSha(newPath) =", wm.storedSha(newPath));
            console.log("knownContentSha(sha) =", wm.knownContentSha(sha!));
            // This is EXACTLY the jsonl-work-unit predicate (lines 232-238):
            const stored = wm.storedSha(newPath);
            const known = sha !== null && (stored === sha || (stored === null && wm.knownContentSha(sha)));
            console.log("=> work-unit would REFRESH-SKIP the parse:", known);
            expect(known).toBe(true);
            yield* conn.close;
        }),
    ), 60000);
});
