/**
 * The DDL-comment -> COMMENT ON transform (#869): parser semantics on small
 * fixtures, plus one live roundtrip proving the comments land in the catalog
 * and survive the snapshot publish, readable via duckdb_columns().
 */
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { join } from "node:path";
import { withIngestLock } from "../ingest-lock.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { parseSchemaComments, schemaCommentStatements } from "./schema-comments.ts";
import { CacheReadLayer, CacheRead, withCacheWrite } from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("schema comments", {
    requireFts: false,
});

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, E>);

const dylibEnv = <A>(body: () => Promise<A>): Promise<A> => {
    const previous = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
    return body().finally(() => {
        if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
        else process.env.AX_DUCKDB_DYLIB = previous;
    });
};

describe("parseSchemaComments", () => {
    const FIXTURE = `
-- ============================
-- Session family
-- ============================
-- One conversation per row.
-- Ids are provider-native.
CREATE TABLE IF NOT EXISTS session (
    id VARCHAR PRIMARY KEY,
    model VARCHAR,  -- last model seen
    -- continuation prose above a column
    labels VARCHAR  -- JSON string[]
);
CREATE INDEX IF NOT EXISTS session_model ON session(model);

CREATE TABLE IF NOT EXISTS bare (
    id VARCHAR PRIMARY KEY,
    n BIGINT
);
`;

    dtest("table prose joins, banners drop, section titles survive", () => {
        const [session, bare] = parseSchemaComments(FIXTURE);
        expect(session!.table).toBe("session");
        expect(session!.comment).toBe(
            "Session family One conversation per row. Ids are provider-native.",
        );
        expect(bare!.table).toBe("bare");
        expect(bare!.comment).toBeNull();
    });

    dtest("column comments: inline, and standalone lines attach to the NEXT column", () => {
        const [session] = parseSchemaComments(FIXTURE);
        expect(session!.columns.get("model")).toBe("last model seen");
        expect(session!.columns.get("labels")).toBe(
            "continuation prose above a column JSON string[]",
        );
        expect(session!.columns.has("id")).toBe(false);
    });

    dtest("statements escape single quotes and end with semicolons", () => {
        const stmts = schemaCommentStatements(
            "-- it's got a quote\nCREATE TABLE IF NOT EXISTS q (\n    id VARCHAR PRIMARY KEY\n);\n",
        );
        expect(stmts).toBe("COMMENT ON TABLE \"q\" IS 'it''s got a quote';");
    });

    dtest("a DDL with no comments emits an empty script", () => {
        expect(schemaCommentStatements("CREATE TABLE IF NOT EXISTS x (\n    id VARCHAR PRIMARY KEY\n);\n")).toBe("");
    });
});

describe("comments land in the catalog (live)", () => {
    const DDL = `
-- What the agent should read instead of docs.
CREATE TABLE IF NOT EXISTS demo (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR  -- 'a' | 'b'
);
`;

    dtest("withCacheWrite applies COMMENT ON; duckdb_columns() reads it off the snapshot", async () => {
        await dylibEnv(async () => {
            const dir = tempDir("comments-live");
            const livePath = join(dir, "live.duckdb");
            const lockPath = join(dir, "ingest.lock");
            const snapshotPath = join(dir, "snapshot.duckdb");

            await run(
                withIngestLock(
                    {
                        lockPath,
                        command: "schema-comments-test",
                        staleMs: 60_000,
                        onBusy: () => Effect.die("lock busy in a fresh temp dir"),
                    },
                    withCacheWrite(
                        { livePath, lockPath, snapshotPath, schemaSql: DDL },
                        (write) => write.exec("INSERT INTO demo VALUES ('x', 'a')"),
                    ),
                ),
            );

            const read = await run(
                Effect.gen(function* () {
                    const cache = yield* CacheRead;
                    const tableComment = yield* cache.raw(
                        "SELECT comment FROM duckdb_tables() WHERE table_name = 'demo'",
                    );
                    const colComment = yield* cache.raw(
                        "SELECT comment FROM duckdb_columns() WHERE table_name = 'demo' AND column_name = 'kind'",
                    );
                    return { tableComment, colComment };
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath }))),
            );
            expect(read.tableComment.rows[0]?.comment).toBe("What the agent should read instead of docs.");
            expect(read.colComment.rows[0]?.comment).toBe("'a' | 'b'");
        });
    });
});
